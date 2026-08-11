import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

import { resolvePinnedAddress } from './network-dns.mjs'
import { readNetworkResponse } from './network-response.mjs'
import { NODE_NETWORK_DEFAULT_LIMITS, NODE_NETWORK_LIMITS, normalizeNetworkRequest } from './network-validation.mjs'

const requestError = code => Object.assign(new Error(`Node network ${code}`), { code })
const networkHostname = url => url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname

const createPinnedLookup = (hostname, resolved) => (requested, options, callback) => {
  if (requested !== hostname) return callback(requestError('dns_rebind'))
  if (options?.all === true) return callback(null, [{ address: resolved.address, family: resolved.family }])
  callback(null, resolved.address, resolved.family)
}

const headerObject = entries => {
  const headers = Object.create(null)
  for (const [name, value] of entries) {
    const current = headers[name]
    headers[name] = current == null ? value : Array.isArray(current) ? [...current, value] : [current, value]
  }
  return headers
}

export class NodeHttpNetworkHost {
  #authority
  #checkServerIdentity
  #httpRequest
  #httpsRequest
  #limits
  #maxResponseBytes
  #nextRequestId = 0
  #observer
  #resolve

  constructor({
    authority,
    checkServerIdentity = tls.checkServerIdentity,
    httpRequest = http.request,
    httpsRequest = https.request,
    limits = NODE_NETWORK_DEFAULT_LIMITS,
    maxResponseBytes = NODE_NETWORK_LIMITS.maxResponseBytes,
    observer,
    resolve = dns.promises.lookup
  }) {
    if (authority == null) throw new TypeError('Node network authority is required')
    if (
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 ||
      maxResponseBytes > NODE_NETWORK_LIMITS.maxResponseBytes
    ) {
      throw new TypeError('Invalid Node network response limit')
    }
    this.#authority = authority
    this.#checkServerIdentity = checkServerIdentity
    this.#httpRequest = httpRequest
    this.#httpsRequest = httpsRequest
    this.#limits = Object.freeze({ ...NODE_NETWORK_DEFAULT_LIMITS, ...limits })
    this.#maxResponseBytes = maxResponseBytes
    this.#observer = observer
    this.#resolve = resolve
  }

  async request(input) {
    const request = normalizeNetworkRequest(input, this.#limits)
    if (request.signal?.aborted === true) throw requestError('aborted')
    const id = `node-network:${++this.#nextRequestId}`
    const hostname = networkHostname(request.url)
    this.#notify({ id, kind: 'request', method: request.method, url: request.url.href })
    try {
      const decision = this.#authority.authorizeRequest(request)
      const selected = await resolvePinnedAddress({
        authority: this.#authority,
        decision,
        hostname,
        request,
        resolve: this.#resolve
      })
      const response = await this.#send(id, request, selected, hostname)
      this.#notify({ bytes: response.body.byteLength, id, kind: 'response', status: response.status })
      return Object.freeze({ ...response, address: selected.address, url: request.url.href })
    } catch (error) {
      this.#notify({ code: error?.code ?? 'request_failed', id, kind: 'error' })
      throw error?.code == null ? requestError('request_failed') : error
    }
  }

  #send(id, request, selected, hostname) {
    return new Promise((resolve, reject) => {
      let settled = false
      let outbound
      const onAbort = () => outbound.destroy(requestError('aborted'))
      const settle = (callback, value) => {
        if (settled) return
        settled = true
        request.signal?.removeEventListener('abort', onAbort)
        callback(value)
      }
      const secure = request.url.protocol === 'https:'
      const options = {
        agent: false,
        headers: headerObject(request.headers),
        hostname,
        lookup: createPinnedLookup(hostname, selected),
        method: request.method,
        path: `${request.url.pathname}${request.url.search}`,
        port: request.url.port || (secure ? 443 : 80),
        ...(secure
          ? {
            checkServerIdentity: (_hostname, certificate) => this.#checkServerIdentity(hostname, certificate),
            servername: hostname
          }
          : {})
      }
      if (request.body != null) options.headers['content-length'] = String(request.body.byteLength)
      options.headers.connection = 'close'
      const transport = secure ? this.#httpsRequest : this.#httpRequest
      outbound = transport(options, response => {
        void readNetworkResponse(response, this.#maxResponseBytes).then(
          value => settle(resolve, value),
          error => settle(reject, error)
        )
      })
      outbound.once('error', error => settle(reject, error?.code == null ? requestError('request_failed') : error))
      outbound.setTimeout(
        Math.min(request.timeoutMs ?? this.#limits.socketTimeoutMs, this.#limits.socketTimeoutMs),
        () => outbound.destroy(requestError('timeout'))
      )
      if (request.signal != null) {
        if (request.signal.aborted) {
          onAbort()
          return
        }
        request.signal.addEventListener('abort', onAbort, { once: true })
      }
      if (request.body != null) outbound.write(request.body)
      outbound.end()
      this.#notify({ address: selected.address, id, kind: 'dispatch' })
    })
  }

  #notify(event) {
    try {
      this.#observer?.(Object.freeze(event))
    } catch {
      // Diagnostics must not alter request semantics.
    }
  }
}
