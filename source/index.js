'use strict'

const qs = require('qs')
const axios = require('axios')
const throttledQueue = require('./throttlePromise')
const RichTextResolver = require('./richTextResolver')
let memory = {}
let cacheVersions = {}

const { delay, getOptionsPage, isCDNUrl } = require('./helpers')


class Storyblok {

  constructor(config, endpoint) {
    if (!endpoint) {
      let region = config.region ? `-${config.region}` : ''
      let protocol = config.https === false ? 'http' : 'https'
      endpoint = `${protocol}://api${region}.storyblok.com/v2`
    }

    let headers = Object.assign({}, config.headers)
    let rateLimit = 5 // per second for cdn api

    if (typeof config.oauthToken != 'undefined') {
      headers['Authorization'] = config.oauthToken
      rateLimit = 3 // per second for management api
    }

    if (typeof config.rateLimit != 'undefined') {
      rateLimit = config.rateLimit
    }

    this.richTextResolver = new RichTextResolver()

    if (typeof config.componentResolver === 'function') {
      this.setComponentResolver(config.componentResolver)
    }

    this.maxRetries = config.maxRetries || 5
    this.throttle = throttledQueue(this.throttledRequest, rateLimit, 1000)
    this.accessToken = config.accessToken
    this.relations = {}
    this.cache = (config.cache || { clear: 'manual' })
    this.client = axios.create({
      baseURL: endpoint,
      timeout: (config.timeout || 0),
      headers: headers,
      proxy: (config.proxy || false)
    })
  }

  setComponentResolver(resolver) {
    this.richTextResolver.addNode('blok', (node) => {
      let html = ''

      node.attrs.body.forEach((blok) => {
        html += resolver(blok.component, blok)
      })

      return {
        html: html
      }
    })
  }

  parseParams(params = {}) {
    if (!params.version) {
      params.version = 'published'
    }

    if (!params.token) {
      params.token = this.getToken()
    }

    if (!params.cv) {
      params.cv = cacheVersions[params.token]
    }

    return params
  }

  factoryParamOptions(url, params = {}) {
    if (isCDNUrl(url)) {
      return this.parseParams(params)
    }

    return params
  }

  makeRequest(url, params, per_page, page) {
    const options = this.factoryParamOptions(
      url,
      getOptionsPage(params, per_page, page)
    )

    return this.cacheResponse(url, options)
  }

  get(slug, params) {
    let url = `/${slug}`
    const query = this.factoryParamOptions(url, params)

    return this.cacheResponse(url, query)
  }

  async getAll(slug, params = {}, entity) {
    const perPage = params.per_page || 25
    let page = 1
    let url = `/${slug}`
    const urlParts = url.split('/')
    entity = entity || urlParts[urlParts.length - 1]

    let res = await this.makeRequest(url, params, perPage, page)
    let all = Object.values(res.data[entity])
    let total = res.total
    let lastPage = Math.ceil((total / perPage))

    while (page < lastPage) {
      page++
      res = await this.makeRequest(url, params, perPage, page)
      all = [
        ...all,
        ...Object.values(res.data[entity])
      ]
    }

    return all
  }

  post(slug, params) {
    let url = `/${slug}`
    return this.throttle('post', url, params)
  }

  put(slug, params) {
    let url = `/${slug}`
    return this.throttle('put', url, params)
  }

  delete(slug, params) {
    let url = `/${slug}`
    return this.throttle('delete', url, params)
  }

  getStories(params) {
    return this.get('cdn/stories', params)
  }

  getStory(slug, params) {
    return this.get(`cdn/stories/${slug}`, params)
  }

  setToken(token) {
    this.accessToken = token
  }

  getToken() {
    return this.accessToken
  }

  insertRelations(story, fields) {
    var enrich = (jtree) => {
      if (jtree == null) {
        return
      }
      if (jtree.constructor === Array) {
        for (var item = 0; item < jtree.length; item++) {
          enrich(jtree[item])
        }
      } else if (jtree.constructor === Object && jtree.component && jtree._uid) {
        for (var treeItem in jtree) {
          if (fields.indexOf(jtree.component + '.' + treeItem) > -1) {
            if (typeof jtree[treeItem] === 'string') {
              if (this.relations[jtree[treeItem]]) {
                jtree[treeItem] = this.relations[jtree[treeItem]]
              }
            } else if (jtree[treeItem].constructor === Array) {
              var stories = []
              jtree[treeItem].forEach(function(uuid) {
                if (this.relations[uuid]) {
                  stories.push(this.relations[uuid])
                }
              })
              jtree[treeItem] = stories
            }
          }
          enrich(jtree[treeItem])
        }
      }
    }

    enrich(story.content)
  }

  async resolveRelations(responseData, params) {
    let relations = []

    if (responseData.rel_uuids) {
      const relSize = responseData.rel_uuids.length
      let chunks = []
      const chunkSize = 50

      for (let i = 0; i < relSize; i += chunkSize) {
        const end = Math.min(relSize, i + chunkSize)
        chunks.push(responseData.rel_uuids.slice(i, end))
      }

      for (var chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        let relationsRes = await this.getStories({per_page: chunkSize, version: params.version, by_uuids: chunks[chunkIndex]})

        relationsRes.data.stories.forEach((rel) => {
          relations.push(rel)
        })
      }
    } else {
      relations = responseData.rels
    }

    relations.forEach((story) => {
      this.relations[story.uuid] = story
    })

    if (responseData.story) {
      this.insertRelations(responseData.story, params.resolve_relations.split(','))
    } else {
      responseData.stories.forEach((story) => {
        this.insertRelations(story, params.resolve_relations.split(','))
      })
    }
  }

  cacheResponse(url, params, retries) {
    if (typeof retries === 'undefined') {
      retries = 0
    }

    return new Promise(async (resolve, reject) => {
      let cacheKey = qs.stringify({ url: url, params: params }, { arrayFormat: 'brackets' })
      let provider = this.cacheProvider()

      if (this.cache.clear === 'auto' && params.version === 'draft') {
        await this.flushCache()
      }

      if (params.version === 'published' && url != '/cdn/spaces/me') {
        const cache = await provider.get(cacheKey)
        if (cache) {
          return resolve(cache)
        }
      }

      try {
        let res = await this.throttle('get', url, {
          params: params,
          paramsSerializer: (params) => qs.stringify(params, { arrayFormat: 'brackets' })
        })

        let response = { data: res.data, headers: res.headers }

        if (res.headers['per-page']) {
          response = Object.assign({}, response, {
            perPage: parseInt(res.headers['per-page']),
            total: parseInt(res.headers['total'])
          })
        }

        if (res.status != 200) {
          return reject(res)
        }

        if (typeof params.resolve_relations !== 'undefined' && params.resolve_relations.length > 0) {
          await this.resolveRelations(response.data, params)
        }

        if (params.version === 'published' && url != '/cdn/spaces/me') {
          provider.set(cacheKey, response)
        }

        if (response.data.cv && (params.version == 'draft' || (res.request._redirectable && res.request._redirectable._redirectCount === 1))) {
          cacheVersions[params.token] = response.data.cv

          if (params.version == 'draft' && cacheVersions[params.token] != response.data.cv) {
            this.flushCache()
          }
        }

        resolve(response)
      } catch (error) {
        if (error.response && error.response.status === 429) {
          retries = retries + 1

          if (retries < this.maxRetries) {
            console.log(`Hit rate limit. Retrying in ${retries} seconds.`)
            await delay(1000 * retries)
            return this.cacheResponse(url, params, retries).then(resolve).catch(reject)
          }
        }
        reject(error)
      }
    })
  }

  throttledRequest(type, url, params) {
    return this.client[type](url, params)
  }

  cacheVersions() {
    return cacheVersions
  }

  cacheVersion() {
    return cacheVersions[this.accessToken]
  }

  setCacheVersion(cv) {
    if (this.accessToken) {
      cacheVersions[this.accessToken] = cv
    }
  }

  cacheProvider() {
    switch (this.cache.type) {
      case 'memory':
        return {
          get(key) {
            return memory[key]
          },
          getAll() {
            return memory
          },
          set(key, content) {
            memory[key] = content
          },
          flush() {
            memory = {}
          }
        }
      default:
        return {
          get() {},
          getAll() {},
          set() {},
          flush() {}
        }
    }
  }

  async flushCache() {
    await this.cacheProvider().flush()
    return this
  }
}

module.exports = Storyblok
