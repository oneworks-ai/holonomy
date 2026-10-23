/* eslint-disable max-lines -- One private VM-network event owner keeps flow cleanup and attribution together. */
import { decodeV86UdpDatagramV1, encodeV86UdpResponseV1 } from '../../../../backends/v86/host/udp.mjs'
import { decodeBase64, encodeBase64 } from '../../../../packages/runtime/src/node-compat/encoding.ts'

import { nativeV86EnvironmentHostsV1 } from './process-v86-transport.mjs'

const MAX_FLOWS = 32
const MAX_PENDING = 64 * 1024
const MAX_WRITE_QUEUE_PER_FLOW = 256 * 1024
const MAX_WRITE_QUEUE_TOTAL = 4 * 1024 * 1024
const CHUNK = 16 * 1024
const HTTP_REDIRECTS = 10
const UDP_IDLE_MS = 30_000
const redirect = status => [301, 302, 303, 307, 308].includes(status)
const synthetic = address => /^192\.168\.(?:87|88)\./u.test(address)
const ipv4 = address =>
  /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(address) &&
  address.split('.').every(part => Number(part) <= 255)

const proxyRequestHeaders = headers => {
  const managed = new Set([
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'proxy-connection',
    'proxy-authorization',
    'proxy-authenticate',
    'keep-alive',
    'te',
    'trailer',
    'upgrade'
  ])
  for (const [name, value] of headers) {
    if (!['connection', 'proxy-connection'].includes(name.toLowerCase())) continue
    for (const token of value.split(',')) managed.add(token.trim().toLowerCase())
  }
  // These belong to the Guest->proxy hop. Rust builds the target Host and
  // content length from the admitted URL and exact body instead.
  return headers.filter(([name]) => !managed.has(name.toLowerCase()))
}

const endpoint = value => {
  const url = new URL(String(value))
  if (
    !['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' ||
    url.hash !== '' || typeof url.hostname !== 'string' || url.hostname.length < 1 ||
    url.hostname.length > 253
  ) throw new TypeError('Invalid v86 HTTP endpoint')
  const port = url.port === '' ? url.protocol === 'https:' ? 443 : 80 : Number(url.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError('Invalid v86 HTTP port')
  return Object.freeze({
    hostname: url.hostname.toLowerCase(),
    port,
    transport: url.protocol === 'https:' ? 'tls' : 'tcp',
    url
  })
}

/** One VM environment's data-plane flows. No Guest-facing API is installed. */
export class NativeV86ProcessNetworkBrokerV1 {
  #port
  #flows = new Map()
  #closed = false
  #queuedWriteBytes = 0

  constructor(port) {
    this.#port = port
  }

  get pendingWriteBytes() {
    return this.#queuedWriteBytes
  }

  resolveNetwork(input) {
    return this.#port.resolveNetwork(input)
  }

  bind(invoke) {
    this.#port.bind(invoke)
  }

  #key(request, streamId) {
    return `${request.environmentId}:${request.generation}:${streamId}`
  }

  #host(request, address) {
    const hostname = nativeV86EnvironmentHostsV1(request.policy)
      .find(host => host.address === address)?.hostname
    if (synthetic(address) && hostname == null) throw new Error('Unknown v86 synthetic address')
    if (!ipv4(address) && hostname == null) throw new Error('Invalid v86 destination address')
    return hostname ?? address
  }

  #admission(request, address, port, transport) {
    return request.consumeNetworkAdmission({ address, port, transport })
  }

  #create(event, request, deliver, kind) {
    const key = this.#key(request, event.streamId)
    const maximum = request.policy?.network?.access === 'restricted'
      ? Math.min(MAX_FLOWS, request.policy.network.maxSockets)
      : 0
    if (
      this.#closed || this.#flows.has(key) || !Number.isSafeInteger(maximum) || maximum < 1 ||
      this.#flows.size >= maximum || request.signal.aborted
    ) {
      deliver({ streamId: event.streamId, action: kind === 'http' ? 'httpError' : 'tcpClose' })
      return undefined
    }
    const flow = {
      key,
      kind,
      request,
      streamId: event.streamId,
      deliver,
      controller: new AbortController(),
      pending: [],
      pendingBytes: 0,
      queuedWriteBytes: 0,
      socketToken: undefined,
      closed: false,
      finReceived: false,
      finQueued: false,
      writing: Promise.resolve(),
      idle: undefined
    }
    this.#flows.set(key, flow)
    return flow
  }

  #close(flow, notify = false) {
    if (flow.closed) return
    flow.closed = true
    this.#flows.delete(flow.key)
    if (flow.idle != null) clearTimeout(flow.idle)
    if (flow.pendingBytes > 0) {
      this.#releaseWriteBytes(flow, flow.pendingBytes)
      flow.pending = []
      flow.pendingBytes = 0
    }
    flow.controller.abort()
    if (flow.socketToken != null) this.#port.close(flow.socketToken)
    if (notify) {
      try {
        flow.deliver({ streamId: flow.streamId, action: flow.kind === 'http' ? 'httpError' : 'tcpClose' })
      } catch {}
    }
  }

  closeEnvironment(environmentId) {
    for (const flow of [...this.#flows.values()]) {
      if (flow.request.environmentId === environmentId) this.#close(flow)
    }
    this.#port.closeEnvironment(environmentId)
  }

  closeGeneration() {
    if (this.#closed) return
    this.#closed = true
    for (const flow of [...this.#flows.values()]) this.#close(flow)
    this.#port.closeGeneration()
  }

  handle(event, request, deliver) {
    if (this.#closed || request.policy?.network?.access !== 'restricted') {
      throw new Error('Native v86 network unavailable')
    }
    if (event.kind === 'tcpOpen') return this.#tcpOpen(event, request, deliver)
    if (event.kind === 'udpFrame') return this.#udpFrame(event, request, deliver)
    if (event.kind === 'httpRequest') return this.#httpRequest(event, request, deliver)
    const flow = this.#flows.get(this.#key(request, event.streamId))
    if (flow == null || flow.closed) return
    if (event.kind === 'tcpData' && flow.kind === 'tcp') return this.#tcpData(flow, event)
    if (event.kind === 'tcpFin' && flow.kind === 'tcp') return this.#tcpFin(flow)
    if (event.kind === 'tcpClose' && flow.kind === 'tcp') return this.#close(flow)
    if (event.kind === 'httpPull' && flow.kind === 'http') return this.#httpPull(flow)
    if (event.kind === 'httpCancel' && flow.kind === 'http') return this.#close(flow)
    throw new Error('Invalid v86 network flow event')
  }

  async #tcpOpen(event, request, deliver) {
    const flow = this.#create(event, request, deliver, 'tcp')
    if (flow == null) return
    try {
      if (!Number.isSafeInteger(event.port) || event.port < 1 || event.port > 65_535) {
        throw new Error('Invalid TCP port')
      }
      const hostname = this.#host(request, event.address)
      const source = this.#admission(request, event.address, event.port, 'tcp')
      const auth = await this.#port.authorize(source, request, { hostname, port: event.port, transport: 'tcp' })
      const opened = await this.#port.task('openTcp', {
        environmentId: request.environmentId,
        resolutionToken: auth.resolutionToken,
        receipt: auth.receipt,
        address: auth.address,
        port: event.port
      }, flow.controller.signal)
      if (flow.closed) return this.#port.close(opened.socketToken)
      flow.socketToken = opened.socketToken
      deliver({ streamId: flow.streamId, action: 'tcpData', base64: '' })
      for (const bytes of flow.pending) this.#writeTcp(flow, bytes)
      flow.pending = []
      flow.pendingBytes = 0
      if (flow.finReceived) this.#queueTcpEnd(flow)
      void this.#readTcp(flow)
    } catch {
      this.#close(flow, true)
    }
  }

  #tcpData(flow, event) {
    if (flow.finReceived) return this.#close(flow, true)
    const bytes = decodeBase64(event.base64)
    if (bytes.byteLength > CHUNK || flow.pendingBytes + bytes.byteLength > MAX_PENDING) {
      return this.#close(flow, true)
    }
    if (!this.#reserveWriteBytes(flow, bytes.byteLength)) return this.#close(flow, true)
    if (flow.socketToken == null) {
      flow.pending.push(bytes)
      flow.pendingBytes += bytes.byteLength
    } else this.#writeTcp(flow, bytes)
  }

  #writeTcp(flow, bytes) {
    flow.writing = flow.writing.then(async () => {
      if (flow.closed) return
      const value = await this.#port.task('writeTcp', {
        socketToken: flow.socketToken,
        base64: encodeBase64(bytes, false)
      }, flow.controller.signal)
      if (value.written !== bytes.byteLength) throw new Error('Short v86 TCP write')
    }).catch(() => this.#close(flow, true)).finally(() => this.#releaseWriteBytes(flow, bytes.byteLength))
  }

  #reserveWriteBytes(flow, length) {
    if (
      flow.queuedWriteBytes + length > MAX_WRITE_QUEUE_PER_FLOW ||
      this.#queuedWriteBytes + length > MAX_WRITE_QUEUE_TOTAL
    ) return false
    flow.queuedWriteBytes += length
    this.#queuedWriteBytes += length
    return true
  }

  #releaseWriteBytes(flow, length) {
    if (length > flow.queuedWriteBytes || length > this.#queuedWriteBytes) {
      throw new Error('Invalid v86 write queue accounting')
    }
    flow.queuedWriteBytes -= length
    this.#queuedWriteBytes -= length
  }

  #tcpFin(flow) {
    if (flow.finReceived) return
    flow.finReceived = true
    if (flow.socketToken != null) this.#queueTcpEnd(flow)
  }

  #queueTcpEnd(flow) {
    if (flow.finQueued) return
    flow.finQueued = true
    flow.writing = flow.writing.then(async () => {
      if (!flow.closed && flow.socketToken != null) {
        await this.#port.task('endTcp', { socketToken: flow.socketToken }, flow.controller.signal)
      }
    }).catch(() => this.#close(flow, true))
  }

  async #readTcp(flow) {
    try {
      while (!flow.closed) {
        const value = await this.#port.task('readTcp', {
          socketToken: flow.socketToken,
          maxBytes: CHUNK
        }, flow.controller.signal)
        if (flow.closed) return
        if (value.eof === true) {
          flow.deliver({ streamId: flow.streamId, action: 'tcpEnd' })
          return this.#close(flow)
        }
        const bytes = decodeBase64(value.base64)
        if (bytes.byteLength < 1 || bytes.byteLength > CHUNK) throw new Error('Invalid v86 TCP read')
        flow.deliver({ streamId: flow.streamId, action: 'tcpData', base64: value.base64 })
      }
    } catch {
      this.#close(flow, true)
    }
  }

  async #udpFrame(event, request, deliver) {
    const frame = decodeBase64(event.base64)
    const packet = decodeV86UdpDatagramV1(frame)
    if (packet == null || packet.internal) return
    const key = this.#key(request, event.streamId)
    let flow = this.#flows.get(key)
    if (flow == null) {
      flow = this.#create(event, request, deliver, 'udp')
      if (flow == null) return
      flow.packet = packet
      if (!this.#reserveWriteBytes(flow, packet.payload.byteLength)) return this.#close(flow, true)
      flow.pending.push(packet.payload)
      flow.pendingBytes = packet.payload.byteLength
      this.#resetUdp(flow)
      try {
        const address = packet.destinationAddress.join('.')
        const hostname = this.#host(request, address)
        const source = this.#admission(request, address, packet.destinationPort, 'udp')
        const auth = await this.#port.authorize(source, request, {
          hostname,
          port: packet.destinationPort,
          transport: 'udp'
        })
        const opened = await this.#port.task('openUdp', {
          environmentId: request.environmentId,
          resolutionToken: auth.resolutionToken,
          receipt: auth.receipt,
          address: auth.address,
          port: packet.destinationPort
        }, flow.controller.signal)
        if (flow.closed) return this.#port.close(opened.socketToken)
        flow.socketToken = opened.socketToken
        void this.#recvUdp(flow)
        for (const queued of flow.pending) this.#sendUdp(flow, queued)
        flow.pending = []
        flow.pendingBytes = 0
        return
      } catch {
        return this.#close(flow, true)
      }
    }
    if (flow.closed) return
    flow.packet = packet
    this.#resetUdp(flow)
    if (flow.socketToken == null) {
      if (flow.pendingBytes + packet.payload.byteLength > MAX_PENDING) return this.#close(flow, true)
      if (!this.#reserveWriteBytes(flow, packet.payload.byteLength)) return this.#close(flow, true)
      flow.pending.push(packet.payload)
      flow.pendingBytes += packet.payload.byteLength
    } else {
      if (!this.#reserveWriteBytes(flow, packet.payload.byteLength)) return this.#close(flow, true)
      this.#sendUdp(flow, packet.payload)
    }
  }

  #resetUdp(flow) {
    if (flow.idle != null) clearTimeout(flow.idle)
    flow.idle = setTimeout(() => this.#close(flow, true), UDP_IDLE_MS)
  }

  #sendUdp(flow, bytes) {
    flow.writing = flow.writing.then(async () => {
      if (flow.closed) return
      const value = await this.#port.task('sendUdp', {
        socketToken: flow.socketToken,
        base64: encodeBase64(bytes, false)
      }, flow.controller.signal)
      if (value.written !== bytes.byteLength) throw new Error('Short v86 UDP send')
    }).catch(() => this.#close(flow, true)).finally(() => this.#releaseWriteBytes(flow, bytes.byteLength))
  }

  async #recvUdp(flow) {
    try {
      while (!flow.closed) {
        const value = await this.#port.task('recvUdp', {
          socketToken: flow.socketToken,
          maxBytes: 1472
        }, flow.controller.signal)
        if (flow.closed) return
        const bytes = decodeBase64(value.base64)
        if (bytes.byteLength > 1472) throw new Error('Invalid v86 UDP response')
        const frame = encodeV86UdpResponseV1(flow.packet, bytes)
        flow.deliver({ streamId: flow.streamId, action: 'udpFrame', base64: encodeBase64(frame, false) })
        this.#resetUdp(flow)
      }
    } catch {
      this.#close(flow, true)
    }
  }

  async #httpRequest(event, request, deliver) {
    const flow = this.#create(event, request, deliver, 'http')
    if (flow == null) return
    try {
      if (
        !Array.isArray(event.headers) || event.headers.length > 64 ||
        typeof event.method !== 'string' || typeof event.bodyBase64 !== 'string'
      ) {
        throw new Error('Invalid v86 HTTP request')
      }
      if (
        event.method.toUpperCase() === 'CONNECT' || event.method.length > 16 ||
        decodeBase64(event.bodyBase64).byteLength > 32 * 1024 ||
        event.headers.some(pair =>
          !Array.isArray(pair) || pair.length !== 2 ||
          typeof pair[0] !== 'string' || typeof pair[1] !== 'string'
        ) ||
        new TextEncoder().encode(JSON.stringify(event.headers)).byteLength > 16 * 1024
      ) throw new Error('Invalid v86 HTTP request')
      const source = this.#admission(request, '192.168.86.1', 80, 'tcp')
      let current = endpoint(event.url)
      let method = event.method
      let headers = proxyRequestHeaders(event.headers)
      let bodyBase64 = event.bodyBase64
      for (let hop = 0; hop <= HTTP_REDIRECTS; hop += 1) {
        const auth = await this.#port.authorize(source, request, current)
        const head = await this.#port.task('httpRequest', {
          environmentId: request.environmentId,
          resolutionToken: auth.resolutionToken,
          receipt: auth.receipt,
          address: auth.address,
          url: current.url.href,
          method,
          headers,
          bodyBase64
        }, flow.controller.signal)
        if (flow.closed) return this.#port.close(head.socketToken)
        const location = head.headers?.find(([name]) => String(name).toLowerCase() === 'location')?.[1]
        if (!redirect(head.status) || location == null) {
          flow.socketToken = head.socketToken
          flow.deliver({
            streamId: flow.streamId,
            action: 'httpHead',
            head: {
              status: head.status,
              statusText: head.statusText,
              headers: head.headers,
              url: head.url,
              redirected: hop > 0
            }
          })
          return
        }
        this.#port.close(head.socketToken)
        if (hop === HTTP_REDIRECTS) throw new Error('v86 HTTP redirect limit')
        if (location.startsWith('//')) throw new Error('Unsupported v86 HTTP redirect')
        const next = endpoint(new URL(location, current.url.href).href)
        if (next.hostname !== current.hostname || next.port !== current.port || next.transport !== current.transport) {
          headers = headers.filter(([name]) => !['authorization', 'cookie', 'cookie2'].includes(name.toLowerCase()))
        }
        current = next
        if (head.status === 303 || [301, 302].includes(head.status) && method === 'POST') {
          method = 'GET'
          bodyBase64 = ''
          headers = headers.filter(([name]) => !['content-length', 'content-type'].includes(name.toLowerCase()))
        }
      }
    } catch {
      this.#close(flow, true)
    }
  }

  async #httpPull(flow) {
    try {
      if (flow.socketToken == null) throw new Error('v86 HTTP response unavailable')
      const result = await this.#port.task('httpPull', {
        socketToken: flow.socketToken,
        maxBytes: CHUNK
      }, flow.controller.signal)
      if (flow.closed) return
      if (result.eof === true) {
        flow.deliver({ streamId: flow.streamId, action: 'httpEnd' })
        return this.#close(flow)
      }
      const bytes = decodeBase64(result.base64)
      if (bytes.byteLength > CHUNK) throw new Error('Invalid v86 HTTP body chunk')
      flow.deliver({ streamId: flow.streamId, action: 'httpChunk', base64: result.base64 })
    } catch {
      this.#close(flow, true)
    }
  }
}
