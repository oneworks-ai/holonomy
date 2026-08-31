import { createSocket } from 'node:dgram'
import { createConnection } from 'node:net'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { LinuxProcessNetworkCapabilityBridgeV1 } from '../../../dist/capability-runtime/index.js'

import {
  leaseProcessNetworkResponseV1,
  normalizeProcessNetworkHostnameV1,
  processNetworkEndpointV1,
  processNetworkFailureV1
} from './capability-process-v86-network-support.mjs'

export class NodeV86ProcessNetworkBrokerV1 {
  #activeSockets = 0
  #authorize = new LinuxProcessNetworkCapabilityBridgeV1()
  #connect
  #createDatagram
  #fetch
  #maxRedirects

  constructor(options = {}) {
    this.#connect = options.createConnection ?? createConnection
    this.#createDatagram = options.createDatagram ?? createSocket
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#maxRedirects = options.maxRedirects ?? 10
    if (
      typeof this.#connect !== 'function' || typeof this.#createDatagram !== 'function' ||
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
    ) return processNetworkFailureV1('process.network_endpoint_unsupported')
    const normalizedHostname = normalizeProcessNetworkHostnameV1(input.hostname)
    const authorization = await this.#authorize.authorize({
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
    if ((globalThis.performance?.now?.() ?? Date.now()) > authorization.resolution.expiresAtMonotonicMs) {
      return processNetworkFailureV1('resource.stale')
    }
    const release = this.#acquire(input.policy)
    return await new Promise((resolve, reject) => {
      const socket = this.#connect({
        host: authorization.resolution.addresses[0],
        port: input.port,
        signal: input.signal
      })
      socket.once('close', release)
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
        release()
        reject(error)
      }
      socket.once('connect', connected)
      socket.once('error', failed)
    })
  }

  async datagram(input) {
    if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) {
      return processNetworkFailureV1('process.network_endpoint_unsupported')
    }
    const normalizedHostname = normalizeProcessNetworkHostnameV1(input.hostname)
    const authorization = await this.#authorize.authorize({
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
    if ((globalThis.performance?.now?.() ?? Date.now()) > authorization.resolution.expiresAtMonotonicMs) {
      return processNetworkFailureV1('resource.stale')
    }
    const release = this.#acquire(input.policy)
    return await new Promise((resolve, reject) => {
      const socket = this.#createDatagram('udp4')
      socket.once('close', release)
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
        release()
        reject(error)
      }
      function aborted() {
        socket.close()
      }
      socket.once('connect', connected)
      socket.once('error', failed)
      socket.connect(input.port, authorization.resolution.addresses[0])
      if (input.signal.aborted) aborted()
    })
  }

  async fetch(input) {
    let current = processNetworkEndpointV1(input.url)
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
      const release = this.#acquire(input.policy)
      let response
      try {
        response = await this.#fetch(current.url, init)
      } catch (error) {
        release()
        throw error
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return leaseProcessNetworkResponseV1(response, release)
      }
      await response.body?.cancel().catch(() => undefined)
      release()
      if (redirects >= this.#maxRedirects) return processNetworkFailureV1('process.network_redirect_limit')
      const location = response.headers.get('location')
      if (location == null) return response
      current = processNetworkEndpointV1(new URL(location, current.url).href)
      if (response.status === 303 || [301, 302].includes(response.status) && init.method === 'POST') {
        init = { ...init, body: undefined, method: 'GET' }
      }
    }
  }

  #acquire(policy) {
    const maximum = policy?.access === 'sandboxed' && policy.network?.access === 'restricted'
      ? policy.network.maxSockets
      : 0
    if (!Number.isInteger(maximum) || maximum < 1 || this.#activeSockets >= maximum) {
      return processNetworkFailureV1('provider.quota')
    }
    this.#activeSockets += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.#activeSockets -= 1
    }
  }
}
