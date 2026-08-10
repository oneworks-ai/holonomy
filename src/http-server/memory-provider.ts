/* eslint-disable max-lines -- the conformance provider keeps its virtual resource lifecycle in one auditable boundary. */

import { Buffer } from '../node-compat/buffer.js'

import { HTTP_SERVER_NATIVE_MODULE, HTTP_SERVER_OPERATIONS, HTTP_SERVER_RESOURCE_TYPES } from './contract.js'
import { createHttpServerError } from './errors.js'
import { resolveHttpServerLimits } from './limits.js'
import { normalizeHeaderEntries } from './validation.js'

import type {
  NativeCallToken,
  NativeDispatchContext,
  NativePort,
  NativePortErrorCode,
  NativePortEventSink,
  NativePortRequest,
  NativePortResourceEventSink,
  NativeProviderToken
} from '../native-port/types.js'
import type {
  HttpServerAddress,
  HttpServerLimits,
  MemoryHttpServerProviderContract,
  MemoryHttpServerProviderOptions,
  VirtualHttpRequest,
  VirtualHttpResponse,
  VirtualWebSocketPeer,
  VirtualWebSocketRequest
} from './types.js'

interface StreamCall {
  readonly callToken: NativeCallToken
  credits: number
  closed: boolean
  flush: () => void
  readonly id: string
  readonly onEnd?: () => void
  readonly resourceSink: NativePortResourceEventSink
  sequence: number
  readonly sink: NativePortEventSink
}

interface ServerResource {
  readonly address: HttpServerAddress
  accept?: StreamCall
  closed: boolean
  readonly connections: Set<ExchangeResource>
  readonly ownerCallToken: NativeCallToken
  readonly ownerResourceSink: NativePortResourceEventSink
  readonly pending: ExchangeResource[]
  readonly principal: string
  readonly token: NativeProviderToken
  readonly type: 'server'
  revoked: boolean
}

interface ResponseState {
  readonly body: Uint8Array[]
  bytes: number
  headers: Readonly<Record<string, string | readonly string[]>>
  resolve: (value: VirtualHttpResponse) => void
  reject: (reason: unknown) => void
  started: boolean
  statusCode: number
  statusMessage?: string
  terminal: boolean
}

interface ExchangeResource {
  bodyOffset: number
  bodyRead?: StreamCall
  closed: boolean
  readonly headers: readonly (readonly [string, string])[]
  readonly head?: Uint8Array
  readonly isUpgrade: boolean
  readonly method: string
  ownerCallToken: NativeCallToken
  ownerResourceSink: NativePortResourceEventSink
  readonly principal: string
  readonly requestBody: Uint8Array
  readonly response: ResponseState
  readonly server: ServerResource
  readonly token: NativeProviderToken
  readonly type: 'exchange'
  upgradeState: 'accepted' | 'closed' | 'pending'
  readonly url: string
  readonly websocketReady?: {
    reject: (reason: unknown) => void
    resolve: (peer: VirtualWebSocketPeer) => void
  }
  revoked: boolean
}

interface WebSocketMessage {
  readonly data: Uint8Array
  readonly isBinary: boolean
}

interface WebSocketResource {
  closed: boolean
  readonly inbound: WebSocketMessage[]
  inboundBytes: number
  readonly outbound: AsyncQueue<WebSocketMessage>
  outboundBytes: number
  readonly ownerCallToken: NativeCallToken
  readonly ownerResourceSink: NativePortResourceEventSink
  readonly principal: string
  read?: StreamCall
  readonly token: NativeProviderToken
  readonly type: 'websocket'
  revoked: boolean
}

type ProviderResource = ExchangeResource | ServerResource | WebSocketResource

class AsyncQueue<T> {
  private closed = false
  private readonly items: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []

  close(discard = true) {
    if (this.closed) return
    this.closed = true
    if (discard) this.items.splice(0)
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift()
    if (item != null) return Promise.resolve({ done: false, value: item })
    if (this.closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise(resolve => this.waiters.push(resolve))
  }

  push(item: T) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter != null) waiter({ done: false, value: item })
    else this.items.push(item)
  }
}

let nextProviderId = 1

export class MemoryHttpServerProvider implements NativePort, MemoryHttpServerProviderContract {
  private readonly capability: string
  private disposed = false
  private nextPort = 41_000
  private nextResource = 1
  private readonly resources = new Map<NativeProviderToken, ProviderResource>()
  private readonly servers = new Map<string, ServerResource>()
  private readonly streams = new Map<NativeCallToken, StreamCall>()
  private readonly limits: Readonly<HttpServerLimits>
  private readonly providerId = nextProviderId++

  constructor(options: MemoryHttpServerProviderOptions = {}) {
    this.capability = options.capability ?? 'http.server'
    this.limits = resolveHttpServerLimits(options.limits)
  }

  cancel(callToken: NativeCallToken, reason?: string) {
    const stream = this.streams.get(callToken)
    if (stream == null || stream.closed) return
    stream.closed = true
    this.streams.delete(callToken)
    stream.sink({
      error: { code: 'cancelled', domain: 'runtime' },
      id: stream.id,
      type: 'error'
    })
    stream.onEnd?.()
    void reason
  }

  closeResource(
    ownerCallToken: NativeCallToken,
    providerToken: NativeProviderToken,
    reason?: string
  ) {
    const resource = this.resources.get(providerToken)
    if (resource == null || resource.ownerCallToken !== ownerCallToken) return
    this.closeProviderResource(resource, reason ?? 'resource_closed', false)
  }

  dispatch(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    resourceSink: NativePortResourceEventSink
  ) {
    if (this.disposed) {
      this.fail(request.id, sink, 'disposed')
      return
    }
    if (request.module !== HTTP_SERVER_NATIVE_MODULE) {
      this.fail(request.id, sink, 'capability_unsupported')
      return
    }
    try {
      this.authorize(context)
      this.dispatchAuthorized(request, context, sink, resourceSink)
    } catch (error) {
      const code = error instanceof ProviderFailure ? error.code : 'protocol_error'
      this.fail(request.id, sink, code)
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const resource of [...this.resources.values()]) this.closeProviderResource(resource, 'provider_disposed')
    this.resources.clear()
    this.servers.clear()
    for (const stream of this.streams.values()) {
      if (!stream.closed) this.fail(stream.id, stream.sink, 'disposed')
    }
    this.streams.clear()
  }

  grantCredits(callToken: NativeCallToken, credits: number) {
    const stream = this.streams.get(callToken)
    if (stream == null || stream.closed) return
    stream.credits += credits
    stream.flush()
  }

  async request(address: HttpServerAddress, request: VirtualHttpRequest): Promise<VirtualHttpResponse> {
    const server = this.servers.get(this.addressKey(address))
    if (server == null || server.closed) throw createHttpServerError('ERR_HOLONOMY_HTTP_ABORTED')
    const exchange = this.createExchange(server, request, false)
    server.pending.push(exchange)
    server.accept?.flush()
    return await new Promise<VirtualHttpResponse>((resolve, reject) => {
      exchange.response.resolve = resolve
      exchange.response.reject = reject
    })
  }

  async websocket(
    address: HttpServerAddress,
    request: VirtualWebSocketRequest = {}
  ): Promise<VirtualWebSocketPeer> {
    const server = this.servers.get(this.addressKey(address))
    if (server == null || server.closed) throw createHttpServerError('ERR_HOLONOMY_HTTP_ABORTED')
    let resolve!: (peer: VirtualWebSocketPeer) => void
    let reject!: (reason: unknown) => void
    const ready = new Promise<VirtualWebSocketPeer>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const exchange = this.createExchange(server, request, true, { resolve, reject })
    server.pending.push(exchange)
    server.accept?.flush()
    return await ready
  }

  private addressKey(address: HttpServerAddress) {
    return `${address.address}:${address.port}`
  }

  private authorize(context: Readonly<NativeDispatchContext>) {
    if (!context.authority.capabilities.includes(this.capability)) {
      throw new ProviderFailure('capability_unsupported')
    }
  }

  private assertResource<Type extends ProviderResource['type']>(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    key: string,
    type: Type
  ): Extract<ProviderResource, { type: Type }> {
    const args = request.args as Record<string, unknown>
    const reference = args[key]
    const binding = context.resources.find(item => item.reference === reference)
    const resource = binding == null ? undefined : this.resources.get(binding.providerToken)
    if (
      binding?.type !== `http.${type}` || resource?.type !== type || resource.closed ||
      binding.ownerCallToken !== resource.ownerCallToken ||
      resource.principal !== context.authority.principal
    ) {
      throw new ProviderFailure('resource_invalid')
    }
    return resource as Extract<ProviderResource, { type: Type }>
  }

  private closeProviderResource(resource: ProviderResource, reason: string, notifyOwner = true) {
    if (resource.closed) return
    resource.closed = true
    if (resource.type === 'exchange') resource.upgradeState = 'closed'
    if (notifyOwner && !resource.revoked) {
      resource.revoked = true
      resource.ownerResourceSink({ providerToken: resource.token, type: 'revoke' })
    }
    this.resources.delete(resource.token)
    if (resource.type === 'server') {
      this.servers.delete(this.addressKey(resource.address))
      this.endStream(resource.accept)
      for (const exchange of [...resource.connections]) this.closeProviderResource(exchange, reason)
      resource.pending.splice(0)
    } else if (resource.type === 'exchange') {
      resource.server.connections.delete(resource)
      const pendingIndex = resource.server.pending.indexOf(resource)
      if (pendingIndex >= 0) resource.server.pending.splice(pendingIndex, 1)
      this.endStream(resource.bodyRead)
      if (!resource.response.terminal) {
        resource.response.terminal = true
        resource.response.reject(createHttpServerError('ERR_HOLONOMY_HTTP_ABORTED'))
      }
      resource.websocketReady?.reject(createHttpServerError('ERR_HOLONOMY_HTTP_ABORTED'))
    } else {
      this.endStream(resource.read)
      resource.inbound.splice(0)
      resource.inboundBytes = 0
      resource.outboundBytes = 0
      resource.outbound.close(false)
    }
  }

  private createExchange(
    server: ServerResource,
    request: VirtualHttpRequest | VirtualWebSocketRequest,
    isUpgrade: boolean,
    websocketReady?: ExchangeResource['websocketReady']
  ): ExchangeResource {
    if (server.connections.size >= this.limits.maxConnections) {
      throw createHttpServerError('ERR_HOLONOMY_HTTP_LIMIT_EXCEEDED')
    }
    const method = request.method ?? 'GET'
    const url = request.url ?? '/'
    if (method === '' || method.length > 32 || url === '' || url.length > 8_192) {
      throw createHttpServerError('ERR_HOLONOMY_HTTP_INVALID_ARGUMENT')
    }
    const headers = Object.entries(request.headers ?? {}).flatMap(([name, value]) =>
      (typeof value === 'string' ? [value] : value).map(item => [name, item] as const)
    )
    normalizeHeaderEntries(headers, this.limits)
    const requestBody = isUpgrade ? undefined : (request as VirtualHttpRequest).body
    const body = requestBody == null
      ? new Uint8Array()
      : typeof requestBody === 'string'
      ? new Uint8Array(Buffer.from(requestBody))
      : new Uint8Array(requestBody)
    if (body.byteLength > this.limits.maxRequestBodyBytes) {
      throw createHttpServerError('ERR_HOLONOMY_HTTP_LIMIT_EXCEEDED')
    }
    const headInput = isUpgrade ? (request as VirtualWebSocketRequest).head : undefined
    if (headInput != null && !(headInput instanceof Uint8Array)) {
      throw createHttpServerError('ERR_HOLONOMY_HTTP_INVALID_ARGUMENT')
    }
    const head = headInput == null ? new Uint8Array() : new Uint8Array(headInput)
    if (head.byteLength > this.limits.maxChunkBytes) throw createHttpServerError('ERR_HOLONOMY_HTTP_LIMIT_EXCEEDED')
    const exchange: ExchangeResource = {
      bodyOffset: 0,
      closed: false,
      headers,
      isUpgrade,
      method,
      ownerCallToken: server.accept?.callToken ?? server.ownerCallToken,
      ownerResourceSink: server.accept?.resourceSink ?? server.ownerResourceSink,
      principal: server.principal,
      requestBody: body,
      response: {
        body: [],
        bytes: 0,
        headers: Object.freeze({}),
        reject: () => undefined,
        resolve: () => undefined,
        started: false,
        statusCode: 200,
        terminal: false
      },
      server,
      token: this.createToken('exchange'),
      type: 'exchange',
      upgradeState: 'pending',
      url,
      ...(websocketReady == null ? {} : { websocketReady }),
      revoked: false,
      ...(isUpgrade ? { head } : {})
    }
    this.resources.set(exchange.token, exchange)
    server.connections.add(exchange)
    return exchange
  }

  private createToken(type: ProviderResource['type']) {
    return `http-provider:${this.providerId}:${type}:${this.nextResource++}` as NativeProviderToken
  }

  private dispatchAuthorized(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    resourceSink: NativePortResourceEventSink
  ) {
    switch (request.operation) {
      case HTTP_SERVER_OPERATIONS.server.open:
        this.openServer(request, context, sink, resourceSink)
        return
      case HTTP_SERVER_OPERATIONS.server.accept:
        this.acceptRequests(request, context, sink, resourceSink)
        return
      case HTTP_SERVER_OPERATIONS.server.close:
        this.closeServer(request, context, sink)
        return
      case HTTP_SERVER_OPERATIONS.request.read:
        this.readRequest(request, context, sink)
        return
      case HTTP_SERVER_OPERATIONS.response.start:
        this.startResponse(request, context, sink)
        return
      case HTTP_SERVER_OPERATIONS.response.write:
        this.writeResponse(request, context, sink)
        return
      case HTTP_SERVER_OPERATIONS.response.end:
        this.endResponse(request, context, sink)
        return
      case HTTP_SERVER_OPERATIONS.exchange.abort:
        this.abortExchange(request, context, sink)
        return
      case HTTP_SERVER_OPERATIONS.websocket.accept:
        this.acceptWebSocket(request, context, sink, resourceSink)
        return
      case HTTP_SERVER_OPERATIONS.websocket.read:
        this.readWebSocket(request, context, sink)
        return
      case HTTP_SERVER_OPERATIONS.websocket.send:
        this.sendWebSocket(request, context, sink)
        return
      case HTTP_SERVER_OPERATIONS.websocket.close:
        this.closeWebSocket(request, context, sink)
        return
      default:
        throw new ProviderFailure('operation_unsupported')
    }
  }

  private openServer(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    resourceSink: NativePortResourceEventSink
  ) {
    if (context.mode !== 'result') throw new ProviderFailure('protocol_error')
    const args = request.args as Record<string, unknown>
    const host = args.host
    const requestedPort = args.port
    if (
      host !== '127.0.0.1' || !Number.isSafeInteger(requestedPort) ||
      (requestedPort as number) < 0 || (requestedPort as number) > 65_535
    ) {
      throw new ProviderFailure('invalid_request')
    }
    const port = requestedPort === 0 ? this.nextPort++ : requestedPort as number
    const address = Object.freeze({ address: host, family: 'IPv4' as const, port })
    if (this.servers.has(this.addressKey(address))) throw new ProviderFailure('exists')
    const resource: ServerResource = {
      address,
      closed: false,
      connections: new Set(),
      ownerCallToken: context.callToken,
      ownerResourceSink: resourceSink,
      pending: [],
      principal: context.authority.principal,
      token: this.createToken('server'),
      type: 'server',
      revoked: false
    }
    this.resources.set(resource.token, resource)
    this.servers.set(this.addressKey(address), resource)
    sink({
      id: request.id,
      resources: [{ providerToken: resource.token, type: HTTP_SERVER_RESOURCE_TYPES.server }],
      type: 'result',
      value: address
    })
  }

  private acceptRequests(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    resourceSink: NativePortResourceEventSink
  ) {
    if (context.mode !== 'stream') throw new ProviderFailure('protocol_error')
    const server = this.assertResource(request, context, 'server', 'server')
    if (server.accept != null) throw new ProviderFailure('exists')
    const call: StreamCall = {
      callToken: context.callToken,
      closed: false,
      credits: 0,
      flush: () => this.flushAccept(server),
      id: request.id,
      resourceSink,
      sequence: 0,
      sink
    }
    server.accept = call
    this.streams.set(call.callToken, call)
  }

  private flushAccept(server: ServerResource) {
    const call = server.accept
    if (call == null) return
    while (true) {
      if (call.closed || call.credits <= 0 || server.pending.length === 0) break
      const exchange = server.pending.shift()!
      exchange.ownerCallToken = call.callToken
      exchange.ownerResourceSink = call.resourceSink
      call.credits -= 1
      call.sink({
        id: call.id,
        ...(exchange.isUpgrade && exchange.head != null
          ? { binary: [{ data: new Uint8Array(exchange.head), handle: 'head' }] }
          : {}),
        resources: [{ providerToken: exchange.token, type: HTTP_SERVER_RESOURCE_TYPES.exchange }],
        sequence: call.sequence++,
        type: 'chunk',
        value: {
          headers: exchange.headers.map(entry => [entry[0], entry[1]]),
          httpVersion: '1.1',
          kind: exchange.isUpgrade ? 'upgrade' : 'request',
          method: exchange.method,
          url: exchange.url
        }
      })
    }
  }

  private closeServer(request: NativePortRequest, context: Readonly<NativeDispatchContext>, sink: NativePortEventSink) {
    const server = this.assertResource(request, context, 'server', 'server')
    this.closeProviderResource(server, 'server_close')
    this.ok(request.id, sink)
  }

  private readRequest(request: NativePortRequest, context: Readonly<NativeDispatchContext>, sink: NativePortEventSink) {
    if (context.mode !== 'stream') throw new ProviderFailure('protocol_error')
    const exchange = this.assertResource(request, context, 'exchange', 'exchange')
    if (exchange.bodyRead != null) throw new ProviderFailure('exists')
    const call: StreamCall = {
      callToken: context.callToken,
      closed: false,
      credits: 0,
      flush: () => this.flushRequestBody(exchange),
      id: request.id,
      resourceSink: () => undefined,
      sequence: 0,
      sink
    }
    exchange.bodyRead = call
    this.streams.set(call.callToken, call)
  }

  private flushRequestBody(exchange: ExchangeResource) {
    const call = exchange.bodyRead
    if (call == null) return
    while (true) {
      if (call.closed || call.credits <= 0 || exchange.bodyOffset >= exchange.requestBody.byteLength) break
      const end = Math.min(exchange.requestBody.byteLength, exchange.bodyOffset + this.limits.maxChunkBytes)
      const chunk = exchange.requestBody.slice(exchange.bodyOffset, end)
      exchange.bodyOffset = end
      call.credits -= 1
      call.sink({ binary: [{ data: chunk, handle: 'body' }], id: call.id, sequence: call.sequence++, type: 'chunk' })
    }
    if (call != null && !call.closed && exchange.bodyOffset >= exchange.requestBody.byteLength) this.endStream(call)
  }

  private startResponse(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink
  ) {
    const exchange = this.assertResource(request, context, 'exchange', 'exchange')
    const args = request.args as Record<string, unknown>
    if (
      exchange.response.started || !Number.isSafeInteger(args.statusCode) ||
      (args.statusCode as number) < 100 || (args.statusCode as number) > 999
    ) {
      throw new ProviderFailure('invalid_request')
    }
    const headers = args.headers
    if (!Array.isArray(headers)) throw new ProviderFailure('invalid_request')
    const normalized = normalizeHeaderEntries(headers as Array<readonly [string, string]>, this.limits)
    if (
      args.statusMessage !== undefined &&
      (typeof args.statusMessage !== 'string' || args.statusMessage.includes('\0') ||
        /[\r\n]/u.test(args.statusMessage) ||
        Buffer.byteLength(args.statusMessage) > 1_024)
    ) {
      throw new ProviderFailure('invalid_request')
    }
    exchange.response.started = true
    exchange.response.statusCode = args.statusCode as number
    exchange.response.statusMessage = typeof args.statusMessage === 'string' ? args.statusMessage : undefined
    exchange.response.headers = normalized.headers as Readonly<Record<string, string | readonly string[]>>
    this.ok(request.id, sink)
  }

  private writeResponse(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink
  ) {
    const exchange = this.assertResource(request, context, 'exchange', 'exchange')
    const binary = request.binary ?? []
    if (!exchange.response.started || exchange.response.terminal || binary.length !== 1) {
      throw new ProviderFailure('invalid_request')
    }
    const chunk = binary[0]!.data
    if (
      chunk.byteLength > this.limits.maxChunkBytes ||
      exchange.response.bytes + chunk.byteLength > this.limits.maxResponseBodyBytes
    ) {
      throw new ProviderFailure('limit_exceeded')
    }
    exchange.response.bytes += chunk.byteLength
    exchange.response.body.push(Buffer.from(chunk))
    this.ok(request.id, sink)
  }

  private endResponse(request: NativePortRequest, context: Readonly<NativeDispatchContext>, sink: NativePortEventSink) {
    const exchange = this.assertResource(request, context, 'exchange', 'exchange')
    if (!exchange.response.started || exchange.response.terminal) throw new ProviderFailure('invalid_request')
    exchange.response.terminal = true
    exchange.response.resolve(Object.freeze({
      body: Buffer.concat(exchange.response.body),
      headers: exchange.response.headers,
      statusCode: exchange.response.statusCode,
      ...(exchange.response.statusMessage == null ? {} : { statusMessage: exchange.response.statusMessage })
    }))
    this.ok(request.id, sink)
  }

  private abortExchange(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink
  ) {
    const exchange = this.assertResource(request, context, 'exchange', 'exchange')
    this.closeProviderResource(exchange, 'exchange_abort')
    this.ok(request.id, sink)
  }

  private acceptWebSocket(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    resourceSink: NativePortResourceEventSink
  ) {
    const exchange = this.assertResource(request, context, 'exchange', 'exchange')
    if (!exchange.isUpgrade || exchange.websocketReady == null || exchange.upgradeState !== 'pending') {
      throw new ProviderFailure('invalid_request')
    }
    exchange.upgradeState = 'accepted'
    const resource: WebSocketResource = {
      closed: false,
      inbound: [],
      inboundBytes: 0,
      outbound: new AsyncQueue<WebSocketMessage>(),
      outboundBytes: 0,
      ownerCallToken: context.callToken,
      ownerResourceSink: resourceSink,
      principal: context.authority.principal,
      token: this.createToken('websocket'),
      type: 'websocket',
      revoked: false
    }
    this.resources.set(resource.token, resource)
    exchange.websocketReady.resolve(this.createPeer(resource))
    sink({
      id: request.id,
      resources: [{ providerToken: resource.token, type: HTTP_SERVER_RESOURCE_TYPES.websocket }],
      type: 'result'
    })
  }

  private createPeer(resource: WebSocketResource): VirtualWebSocketPeer {
    return Object.freeze({
      close: (code = 1000, reason = '') => {
        if (resource.closed) return
        if (!Number.isSafeInteger(code) || code < 1000 || code > 4999 || Buffer.byteLength(reason) > 123) {
          throw createHttpServerError('ERR_HOLONOMY_HTTP_INVALID_ARGUMENT')
        }
        const call = resource.read
        if (call != null && !call.closed) {
          call.sink({ id: call.id, sequence: call.sequence++, type: 'chunk', value: { code, kind: 'close', reason } })
          this.endStream(call)
        }
        this.closeProviderResource(resource, 'peer_close')
      },
      next: async () => {
        const result = await resource.outbound.next()
        if (!result.done) resource.outboundBytes = Math.max(0, resource.outboundBytes - result.value.data.byteLength)
        return result
      },
      send: (data: string | Uint8Array, isBinary = typeof data !== 'string') => {
        if (resource.closed) throw createHttpServerError('ERR_HOLONOMY_HTTP_ABORTED')
        const bytes = typeof data === 'string'
          ? new Uint8Array(Buffer.from(data))
          : new Uint8Array(data)
        if (
          bytes.byteLength > this.limits.maxWebSocketMessageBytes ||
          resource.inboundBytes + bytes.byteLength > this.limits.maxWebSocketBufferedBytes
        ) {
          throw createHttpServerError('ERR_HOLONOMY_HTTP_LIMIT_EXCEEDED')
        }
        resource.inboundBytes += bytes.byteLength
        resource.inbound.push({ data: bytes, isBinary })
        resource.read?.flush()
      }
    })
  }

  private readWebSocket(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink
  ) {
    if (context.mode !== 'stream') throw new ProviderFailure('protocol_error')
    const websocket = this.assertResource(request, context, 'websocket', 'websocket')
    if (websocket.read != null) throw new ProviderFailure('exists')
    const call: StreamCall = {
      callToken: context.callToken,
      closed: false,
      credits: 0,
      flush: () => this.flushWebSocket(websocket),
      id: request.id,
      onEnd: () => {
        if (websocket.read === call) websocket.read = undefined
      },
      resourceSink: () => undefined,
      sequence: 0,
      sink
    }
    websocket.read = call
    this.streams.set(call.callToken, call)
  }

  private flushWebSocket(websocket: WebSocketResource) {
    const call = websocket.read
    if (call == null) return
    while (true) {
      if (call.closed || call.credits <= 0 || websocket.inbound.length === 0) break
      const message = websocket.inbound.shift()!
      websocket.inboundBytes -= message.data.byteLength
      call.credits -= 1
      call.sink({
        binary: [{ data: message.data, handle: 'message' }],
        id: call.id,
        sequence: call.sequence++,
        type: 'chunk',
        value: { isBinary: message.isBinary, kind: 'message' }
      })
    }
  }

  private sendWebSocket(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink
  ) {
    const websocket = this.assertResource(request, context, 'websocket', 'websocket')
    const binary = request.binary ?? []
    const isBinary = (request.args as Record<string, unknown>).isBinary
    if (
      binary.length !== 1 || typeof isBinary !== 'boolean' ||
      binary[0]!.data.byteLength > this.limits.maxWebSocketMessageBytes ||
      websocket.outboundBytes + binary[0]!.data.byteLength > this.limits.maxWebSocketBufferedBytes
    ) {
      throw new ProviderFailure('invalid_request')
    }
    websocket.outboundBytes += binary[0]!.data.byteLength
    websocket.outbound.push({ data: Buffer.from(binary[0]!.data), isBinary })
    this.ok(request.id, sink)
  }

  private closeWebSocket(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink
  ) {
    const websocket = this.assertResource(request, context, 'websocket', 'websocket')
    this.closeProviderResource(websocket, 'websocket_close')
    this.ok(request.id, sink)
  }

  private endStream(call: StreamCall | undefined) {
    if (call == null || call.closed) return
    call.closed = true
    this.streams.delete(call.callToken)
    call.sink({ id: call.id, type: 'end' })
    call.onEnd?.()
  }

  private fail(id: string, sink: NativePortEventSink, code: NativePortErrorCode) {
    sink({ error: { code, domain: 'runtime' }, id, type: 'error' })
  }

  private ok(id: string, sink: NativePortEventSink) {
    sink({ id, type: 'result', value: { ok: true } })
  }
}

class ProviderFailure extends Error {
  constructor(readonly code: NativePortErrorCode) {
    super(code)
  }
}

export const createMemoryHttpServerProvider = (
  options?: MemoryHttpServerProviderOptions
): MemoryHttpServerProviderContract => new MemoryHttpServerProvider(options)
