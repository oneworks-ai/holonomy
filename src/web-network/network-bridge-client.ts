/* eslint-disable max-lines -- request cancellation and tracked stream cleanup share the Bridge adapter boundary. */

import { NativeBridgeError } from '../native-port/errors.js'

import { WEB_NETWORK_MODULE } from './contract.js'
import { createWebNetworkError, isWebNetworkErrorCode } from './errors.js'

import type {
  NativeArgumentValue,
  NativeBinary,
  NativeBridge,
  NativeCallOptions,
  NativeChunk,
  NativeJsonValue,
  NativeRequest,
  NativeResult,
  NativeStream
} from '../native-port/types.js'

export interface NetworkBridgeCallOptions {
  deadlineMs?: number
  signal?: AbortSignal
  timeoutMs?: number
}

const mapBridgeError = (error: unknown) => {
  if (!(error instanceof NativeBridgeError)) {
    return createWebNetworkError('network.internal')
  }
  if (error.domain === 'network') {
    if (error.code === 'connection_refused') return createWebNetworkError('network.connection_refused')
    if (error.code === 'timeout') return createWebNetworkError('network.timeout')
    if (error.code === 'unavailable') return createWebNetworkError('network.offline')
  }
  if (error.code === 'cancelled' || error.code === 'disposed') {
    return createWebNetworkError('network.cancelled')
  }
  if (error.code === 'timeout') return createWebNetworkError('network.timeout')
  if (error.code === 'capability_unsupported') return createWebNetworkError('network.invalid_url')
  if (
    error.code === 'invalid_request' ||
    error.code === 'invalid_value' ||
    error.code === 'limit_exceeded' ||
    error.code === 'protocol_error' ||
    error.code === 'resource_invalid'
  ) return createWebNetworkError('network.protocol_error')
  return createWebNetworkError('network.internal')
}

export const decodeNetworkValue = (value: NativeJsonValue | undefined) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw createWebNetworkError('network.protocol_error')
  }
  const record = value as Record<string, NativeJsonValue>
  if (record.ok === false && isWebNetworkErrorCode(record.error)) {
    throw createWebNetworkError(record.error)
  }
  if (record.ok !== true || !Object.hasOwn(record, 'value')) {
    throw createWebNetworkError('network.protocol_error')
  }
  return record.value
}

const closeResultResources = (result: Pick<NativeResult, 'resources'>, reason: string) => {
  for (const resource of result.resources ?? []) resource.close(reason)
}

const validateResultResources = (operation: string, result: NativeResult) => {
  const resources = result.resources ?? []
  const validRequestGrant = operation === 'v1.http.request' &&
    resources.length === 1 && resources[0]?.type === 'network.http'
  const validEmptyGrant = operation !== 'v1.http.request' && resources.length === 0
  if (validRequestGrant || validEmptyGrant) return result
  closeResultResources(result, 'unexpected_network_resource')
  throw createWebNetworkError('network.protocol_error')
}

export class NetworkBridgeClient {
  private disposed = false
  private generation = 0
  private readonly pendingIds = new Set<string>()
  private readonly streams = new Set<NativeStream>()
  private nextRequest = 1

  constructor(private readonly bridge: NativeBridge) {}

  async request(
    operation: string,
    args: NativeArgumentValue,
    options: NetworkBridgeCallOptions = {},
    binary?: readonly Uint8Array[]
  ): Promise<NativeResult> {
    const request = this.createRequest(operation, args, options, binary)
    const generation = this.generation
    let removeAbort = () => {}
    try {
      if (this.disposed) throw createWebNetworkError('network.cancelled')
      if (options.signal?.aborted) throw createWebNetworkError('network.cancelled')
      this.pendingIds.add(request.id)
      removeAbort = this.listenForAbort(options.signal, () => {
        this.bridge.cancel(request.id, 'abort')
      })
      if (options.signal?.aborted) throw createWebNetworkError('network.cancelled')
      const result = await this.bridge.request(request, this.callOptions(options))
      if (this.disposed || this.generation !== generation) {
        closeResultResources(result, 'network_client_disposed')
        throw createWebNetworkError('network.cancelled')
      }
      return validateResultResources(operation, result)
    } catch (error) {
      if (isWebNetworkErrorCode((error as { code?: unknown })?.code)) throw error
      throw mapBridgeError(error)
    } finally {
      removeAbort()
      this.pendingIds.delete(request.id)
    }
  }

  stream(
    operation: string,
    args: NativeArgumentValue,
    options: NetworkBridgeCallOptions = {}
  ): NativeStream {
    const request = this.createRequest(operation, args, options)
    const generation = this.generation
    try {
      if (this.disposed) throw createWebNetworkError('network.cancelled')
      if (options.signal?.aborted) throw createWebNetworkError('network.cancelled')
      const stream = this.bridge.stream(request, this.callOptions(options))
      this.streams.add(stream)
      return new TrackedNativeStream(
        stream,
        () => !this.disposed && this.generation === generation,
        () => this.streams.delete(stream)
      )
    } catch (error) {
      if (isWebNetworkErrorCode((error as { code?: unknown })?.code)) throw error
      throw mapBridgeError(error)
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    for (const id of [...this.pendingIds]) this.bridge.cancel(id, 'network_runtime_disposed')
    for (const stream of [...this.streams]) stream.close('network_runtime_disposed')
    this.pendingIds.clear()
    this.streams.clear()
  }

  normalizeError(error: unknown) {
    if (isWebNetworkErrorCode((error as { code?: unknown })?.code)) return error
    return mapBridgeError(error)
  }

  private callOptions(options: NetworkBridgeCallOptions): NativeCallOptions {
    return {
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs })
    }
  }

  private listenForAbort(signal: AbortSignal | undefined, cancel: () => void) {
    if (signal == null) return () => {}
    const listener = () => cancel()
    try {
      signal.addEventListener('abort', listener, { once: true })
    } catch {
      throw createWebNetworkError('network.internal')
    }
    return () => {
      try {
        signal.removeEventListener('abort', listener)
      } catch {
        // A hostile signal cannot expose provider or Bridge details during cleanup.
      }
    }
  }

  private createRequest(
    operation: string,
    args: NativeArgumentValue,
    options: NetworkBridgeCallOptions,
    binary?: readonly Uint8Array[]
  ): NativeRequest {
    const id = `network:${this.nextRequest++}`
    const handles: NativeBinary[] | undefined = binary?.map((data, index) => ({
      data,
      handle: `${id}:input:${index}`
    }))
    return {
      args,
      ...(handles == null ? {} : { binary: handles }),
      ...(options.deadlineMs == null ? {} : { deadlineMs: options.deadlineMs }),
      id,
      module: WEB_NETWORK_MODULE,
      operation
    }
  }
}

class TrackedNativeStream implements NativeStream {
  readonly id: string
  private closed = false

  constructor(
    private readonly source: NativeStream,
    private readonly isCurrent: () => boolean,
    private readonly release: () => void
  ) {
    this.id = source.id
  }

  [Symbol.asyncIterator]() {
    return this
  }

  async next(): Promise<IteratorResult<NativeChunk, NativeResult | undefined>> {
    try {
      if (this.closed || !this.isCurrent()) {
        this.close('network_client_disposed')
        throw createWebNetworkError('network.cancelled')
      }
      const result = await this.source.next()
      if (!this.isCurrent()) {
        closeResultResources(result.value ?? {}, 'network_client_disposed')
        this.close('network_client_disposed')
        throw createWebNetworkError('network.cancelled')
      }
      try {
        validateResultResources('v1.http.read-body', result.value ?? {})
      } catch (error) {
        this.close('unexpected_network_resource')
        throw error
      }
      if (result.done) this.finish()
      return result
    } catch (error) {
      this.finish()
      throw error
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
