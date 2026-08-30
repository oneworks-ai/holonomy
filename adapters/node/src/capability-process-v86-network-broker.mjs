import { createSocket } from 'node:dgram'
import { createConnection, isIP } from 'node:net'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { LinuxProcessNetworkCapabilityBridgeV1 } from '../../../dist/capability-runtime/index.js'

const invalid = code => {
  const error = new Error('v86 process network bridge failed')
  Object.defineProperty(error, 'code', { enumerable: true, value: code })
  throw error
}

const hostname = value => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
    return invalid('process.network_endpoint_unsupported')
  }
  const normalized = value.toLowerCase()
  if (isIP(normalized) !== 0) return normalized
  try {
    const url = new URL(`http://${normalized}/`)
    if (url.hostname !== normalized || url.port !== '' || url.username !== '' || url.password !== '') {
      return invalid('process.network_endpoint_unsupported')
    }
  } catch {
    return invalid('process.network_endpoint_unsupported')
  }
  return normalized
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
    url.hash !== ''
  ) return invalid('process.network_endpoint_unsupported')
  const normalizedHostname = hostname(url.hostname)
  if (isIP(normalizedHostname) === 0) return invalid('process.network_endpoint_unsupported')
  return Object.freeze({
    hostname: normalizedHostname,
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

  async connect(input) {
    if (
      !Number.isSafeInteger(input.port) ||
      input.port < 1 || input.port > 65_535
    ) return invalid('process.network_endpoint_unsupported')
    const normalizedHostname = hostname(input.hostname)
    await this.#authorize.authorize({
      environmentId: input.environmentId,
      executableId: input.executableId,
      hostname: normalizedHostname,
      linuxPid: input.linuxPid,
      policy: input.policy,
      port: input.port,
      processId: input.processId,
      processResourceId: input.processResourceId,
      scope: input.scope,
      transport: 'tcp'
    })
    return await new Promise((resolve, reject) => {
      const socket = createConnection({
        host: normalizedHostname,
        port: input.port,
        signal: input.signal
      })
      function cleanup() {
        socket.removeListener('connect', connected)
        socket.removeListener('error', failed)
      }
      function connected() {
        cleanup()
        resolve(socket)
      }
      function failed(error) {
        cleanup()
        socket.destroy()
        reject(error)
      }
      socket.once('connect', connected)
      socket.once('error', failed)
    })
  }

  async datagram(input) {
    if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) {
      return invalid('process.network_endpoint_unsupported')
    }
    const normalizedHostname = hostname(input.hostname)
    await this.#authorize.authorize({
      environmentId: input.environmentId,
      executableId: input.executableId,
      hostname: normalizedHostname,
      linuxPid: input.linuxPid,
      policy: input.policy,
      port: input.port,
      processId: input.processId,
      processResourceId: input.processResourceId,
      scope: input.scope,
      transport: 'udp'
    })
    return await new Promise((resolve, reject) => {
      const socket = createSocket('udp4')
      function cleanup() {
        input.signal.removeEventListener('abort', aborted)
        socket.removeListener('connect', connected)
        socket.removeListener('error', failed)
      }
      function connected() {
        cleanup()
        input.signal.addEventListener('abort', aborted, { once: true })
        resolve(socket)
      }
      function failed(error) {
        cleanup()
        socket.close()
        reject(error)
      }
      function aborted() {
        socket.close()
      }
      socket.once('connect', connected)
      socket.once('error', failed)
      socket.connect(input.port, normalizedHostname)
      if (input.signal.aborted) aborted()
    })
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
