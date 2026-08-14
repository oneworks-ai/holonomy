import { isIP } from 'node:net'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { LinuxProcessNetworkCapabilityBridgeV1 } from '../../../dist/capability-runtime/index.js'

const invalid = code => {
  const error = new Error('v86 process network bridge failed')
  Object.defineProperty(error, 'code', { enumerable: true, value: code })
  throw error
}

const endpoint = value => {
  let url
  try {
    url = new URL(value)
  } catch {
    return invalid('process.network_url_invalid')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' ||
    url.hash !== '' || isIP(url.hostname) === 0
  ) return invalid('process.network_endpoint_unsupported')
  return Object.freeze({
    hostname: url.hostname,
    port: url.port === '' ? url.protocol === 'https:' ? 443 : 80 : Number(url.port),
    transport: url.protocol === 'https:' ? 'tls' : 'tcp',
    url
  })
}

export class NodeV86ProcessNetworkBrokerV1 {
  #authorize = new LinuxProcessNetworkCapabilityBridgeV1()
  #fetch
  #maxRedirects

  constructor(options = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#maxRedirects = options.maxRedirects ?? 10
    if (
      typeof this.#fetch !== 'function' || !Number.isInteger(this.#maxRedirects) ||
      this.#maxRedirects < 0 || this.#maxRedirects > 32
    ) throw new TypeError('Invalid v86 process network bridge')
  }

  bind(invoke) {
    this.#authorize.bind(invoke)
    return this
  }

  async fetch(input) {
    let current = endpoint(input.url)
    let init = { ...input.init, redirect: 'manual', signal: input.signal }
    for (let redirects = 0;; redirects += 1) {
      await this.#authorize.authorize({
        environmentId: input.environmentId,
        executableId: input.executableId,
        hostname: current.hostname,
        linuxPid: input.linuxPid,
        policy: input.policy,
        port: current.port,
        processId: input.processId,
        processResourceId: input.processResourceId,
        scope: input.scope,
        transport: current.transport
      })
      const response = await this.#fetch(current.url, init)
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      if (redirects >= this.#maxRedirects) return invalid('process.network_redirect_limit')
      const location = response.headers.get('location')
      if (location == null) return response
      current = endpoint(new URL(location, current.url).href)
      if (response.status === 303 || [301, 302].includes(response.status) && init.method === 'POST') {
        init = { ...init, body: undefined, method: 'GET' }
      }
    }
  }
}
