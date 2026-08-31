import { HTTP_SERVER_NATIVE_MODULE, HTTP_SERVER_OPERATIONS, HTTP_SERVER_RESOURCE_TYPES } from './contract.js'
import { createHttpServerError, mapHttpServerBridgeError } from './errors.js'

import type {
  NativeArgumentValue,
  NativeBinary,
  NativeBridge,
  NativeRequest,
  NativeResult,
  NativeStream
} from '../native-port/types.js'

export class HttpServerBridgeClient {
  private disposed = false
  private nextRequestId = 1
  private readonly pending = new Set<string>()
  private readonly streams = new Set<NativeStream>()

  constructor(private readonly bridge: NativeBridge) {}

  async request(
    operation: string,
    args: NativeArgumentValue,
    binary?: readonly Uint8Array[]
  ): Promise<NativeResult> {
    if (this.disposed) throw createHttpServerError('ERR_HOLONOMY_HTTP_DISPOSED')
    const request = this.createRequest(operation, args, binary)
    this.pending.add(request.id)
    try {
      const result = await this.bridge.request(request)
      if (this.disposed) {
        for (const resource of result.resources ?? []) resource.close('http_runtime_disposed')
        throw createHttpServerError('ERR_HOLONOMY_HTTP_DISPOSED')
      }
      return this.decodeUnaryResult(operation, result)
    } catch (error) {
      if (error instanceof Error && error.name === 'HttpServerError') throw error
      throw mapHttpServerBridgeError(error)
    } finally {
      this.pending.delete(request.id)
    }
  }

  private decodeUnaryResult(operation: string, result: NativeResult): NativeResult {
    const resources = result.resources ?? []
    const binary = result.binary ?? []
    const expectedType = operation === HTTP_SERVER_OPERATIONS.server.open
      ? HTTP_SERVER_RESOURCE_TYPES.server
      : operation === HTTP_SERVER_OPERATIONS.websocket.accept
      ? HTTP_SERVER_RESOURCE_TYPES.websocket
      : undefined
    const resourcesValid = expectedType == null
      ? resources.length === 0
      : resources.length === 1 && resources[0]?.type === expectedType
    const valueValid = operation === HTTP_SERVER_OPERATIONS.server.open
      ? result.value !== undefined
      : operation === HTTP_SERVER_OPERATIONS.websocket.accept
      ? result.value === undefined
      : this.isAcknowledgement(result.value)
    if (!resourcesValid || binary.length !== 0 || !valueValid) {
      for (const resource of resources) resource.close('unexpected_unary_resource')
      throw createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL')
    }
    return result
  }

  private isAcknowledgement(value: unknown) {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
    const entries = Object.entries(value)
    return entries.length === 1 && entries[0]?.[0] === 'ok' && entries[0][1] === true
  }

  stream(operation: string, args: NativeArgumentValue): NativeStream {
    if (this.disposed) throw createHttpServerError('ERR_HOLONOMY_HTTP_DISPOSED')
    try {
      const source = this.bridge.stream(this.createRequest(operation, args))
      this.streams.add(source)
      return new TrackedHttpServerStream(source, () => this.streams.delete(source))
    } catch (error) {
      throw mapHttpServerBridgeError(error)
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const id of this.pending) this.bridge.cancel(id, 'http_runtime_disposed')
    for (const stream of this.streams) stream.close('http_runtime_disposed')
    this.pending.clear()
    this.streams.clear()
  }

  private createRequest(
    operation: string,
    args: NativeArgumentValue,
    binary?: readonly Uint8Array[]
  ): NativeRequest {
    const id = `http-server:${this.nextRequestId++}`
    const handles: NativeBinary[] | undefined = binary?.map((data, index) => ({
      data: new Uint8Array(data),
      handle: `${id}:binary:${index}`
    }))
    return {
      args,
      ...(handles == null ? {} : { binary: handles }),
      id,
      module: HTTP_SERVER_NATIVE_MODULE,
      operation
    }
  }
}

class TrackedHttpServerStream implements NativeStream {
  readonly id: string
  private closed = false

  constructor(
    private readonly source: NativeStream,
    private readonly release: () => void
  ) {
    this.id = source.id
  }

  [Symbol.asyncIterator]() {
    return this
  }

  async next() {
    if (this.closed) return { done: true as const, value: undefined }
    try {
      const result = await this.source.next()
      if (result.done) this.finish()
      return result
    } catch (error) {
      this.finish()
      throw mapHttpServerBridgeError(error)
    }
  }

  close(reason?: string) {
    if (this.closed) return false
    const closed = this.source.close(reason)
    this.finish()
    return closed
  }

  private finish() {
    if (this.closed) return
    this.closed = true
    this.release()
  }
}
