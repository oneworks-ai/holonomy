/* eslint-disable max-lines -- public request, provider and resource contracts are reviewed as one ABI surface. */

export type NativeJsonPrimitive = boolean | null | number | string
export type NativeJsonValue =
  | NativeJsonPrimitive
  | NativeJsonValue[]
  | { [key: string]: NativeJsonValue }

declare const NATIVE_CALL_TOKEN_BRAND: unique symbol
declare const NATIVE_PROVIDER_TOKEN_BRAND: unique symbol

/** Runtime-created, non-reusable provider identity for one admission. */
export type NativeCallToken = string & {
  readonly [NATIVE_CALL_TOKEN_BRAND]: true
}

/**
 * Provider-internal same-process identity. It is an opaque bounded scalar and
 * must stay out of guest values and platform/JNI request envelopes.
 */
export type NativeProviderToken = string & {
  readonly [NATIVE_PROVIDER_TOKEN_BRAND]: true
}

/**
 * Guest-visible opaque resource. The provider token is deliberately absent;
 * object identity is validated by the controller on later requests.
 */
export interface NativeResourceHandle {
  readonly type: string
  close(reason?: string): boolean
}

export type NativeArgumentValue =
  | NativeJsonPrimitive
  | NativeResourceHandle
  | NativeArgumentValue[]
  | { [key: string]: NativeArgumentValue }

export type NativeBinarySource = ArrayBuffer | Uint8Array

export interface NativeBinary<TData extends NativeBinarySource = NativeBinarySource> {
  data: TData
  handle: string
}

/**
 * The only guest-to-native request shape. Runtime authority is deliberately
 * absent and is delivered to the provider through NativeDispatchContext.
 */
export interface NativeRequest<TData extends NativeBinarySource = NativeBinarySource> {
  args: NativeArgumentValue
  binary?: readonly NativeBinary<TData>[]
  /** Absolute monotonic deadline in the injected event loop's time domain. */
  deadlineMs?: number
  id: string
  module: string
  operation: string
}

export interface NativeResult<TData extends NativeBinarySource = Uint8Array> {
  binary?: readonly NativeBinary<TData>[]
  resources?: readonly NativeResourceHandle[]
  value?: NativeJsonValue
}

export interface NativeChunk<TData extends NativeBinarySource = Uint8Array> extends NativeResult<TData> {
  sequence: number
}

export type NativePortErrorCode =
  | 'cancelled'
  | 'capability_unsupported'
  | 'disposed'
  | 'internal'
  | 'invalid_request'
  | 'invalid_value'
  | 'limit_exceeded'
  | 'not_found'
  | 'operation_unsupported'
  | 'exists'
  | 'permission_denied'
  | 'protocol_error'
  | 'resource_invalid'
  | 'connection_refused'
  | 'timeout'
  | 'unavailable'

export type NativePortErrorDomain = 'fs' | 'network' | 'runtime'

export interface NativePortErrorDetails {
  readonly resource?: 'directory' | 'file' | 'host' | 'socket'
  readonly retryable?: boolean
}

export interface NativePortErrorData {
  code: NativePortErrorCode
  details?: NativePortErrorDetails
  domain?: NativePortErrorDomain
}

/**
 * Provider-to-runtime asynchronous delivery. Result/error are unary terminals;
 * end/error are stream terminals; chunk is non-terminal and consumes credit.
 */
export type NativePortEvent =
  | {
    binary?: readonly NativeBinary[]
    id: string
    resources?: readonly NativePortResourceGrant[]
    type: 'result'
    value?: NativeJsonValue
  }
  | {
    error: NativePortErrorData
    id: string
    type: 'error'
  }
  | {
    binary?: readonly NativeBinary[]
    id: string
    resources?: readonly NativePortResourceGrant[]
    sequence: number
    type: 'chunk'
    value?: NativeJsonValue
  }
  | {
    binary?: readonly NativeBinary[]
    id: string
    resources?: readonly NativePortResourceGrant[]
    type: 'end'
    value?: NativeJsonValue
  }

export type NativePortEventSink = (event: NativePortEvent) => void

export interface NativeAuthority {
  capabilities: readonly string[]
  principal: string
}

export interface NativeDispatchContext {
  /**
   * Host-injected authority. Providers must re-authorize this authority against
   * the module and operation immediately before executing the request.
   */
  authority: Readonly<NativeAuthority>
  callToken: NativeCallToken
  mode: 'result' | 'stream'
  /** Provider-only bindings for opaque handles found in request.args. */
  resources: readonly NativePortResourceBinding[]
}

export interface NativePortResourceBinding {
  readonly ownerCallToken: NativeCallToken
  readonly providerToken: NativeProviderToken
  /** Exact object identity placed in request.args; never match structurally. */
  readonly reference: NativePortResourceReference
  readonly type: string
}

export interface NativePortResourceGrant {
  /**
   * Allocated by the same-process adapter after any JNI/native response is
   * decoded. A raw descriptor, pointer or platform handle is never this token.
   */
  readonly providerToken: NativeProviderToken
  readonly type: string
}

export interface NativePortResourceReference {
  readonly resource: string
}

export type NativePortArgumentValue =
  | NativeJsonPrimitive
  | NativePortResourceReference
  | NativePortArgumentValue[]
  | { [key: string]: NativePortArgumentValue }

export interface NativePortResourceEvent {
  readonly providerToken: NativeProviderToken
  readonly type: 'revoke'
}

export type NativePortResourceEventSink = (
  event: NativePortResourceEvent
) => void

export interface NativePortRequest extends Omit<NativeRequest<Uint8Array>, 'args'> {
  args: NativePortArgumentValue
}

/**
 * Platform provider boundary. Implementations must not emit a chunk without
 * credit, must release request binary handles at terminal/cancel, and must
 * treat cancel/dispose as idempotent. Every dispatched request must eventually
 * emit exactly one mode-appropriate terminal unless the bridge cancels it.
 */
export interface NativePort {
  cancel(callToken: NativeCallToken, reason?: string): void | Promise<void>
  closeResource(
    ownerCallToken: NativeCallToken,
    providerToken: NativeProviderToken,
    reason?: string
  ): void | Promise<void>
  dispatch(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    resourceSink: NativePortResourceEventSink
  ): void | Promise<void>
  dispose(): void | Promise<void>
  grantCredits(
    callToken: NativeCallToken,
    credits: number
  ): void | Promise<void>
}

export interface NativeBridgeLimits {
  maxBinaryBytes: number
  maxBinaryHandles: number
  maxCreditsPerStream: number
  maxHandles: number
  maxInFlightBinaryBytes: number
  maxInFlightBinaryHandles: number
  maxInlineBytes: number
  maxJsonDepth: number
  maxOpenResources: number
  maxOutstandingCredits: number
  maxPendingRequests: number
  maxTimeoutMs: number
}

export interface NativeBridgeOptions {
  authority: NativeAuthority
  eventLoop: import('../event-loop/runtime-event-loop.js').RuntimeEventLoop
  limits?: Partial<NativeBridgeLimits>
}

export interface NativeCallOptions {
  signal?: AbortSignal
  /** Relative timeout converted to an absolute request deadline at admission. */
  timeoutMs?: number
}

export interface NativeBridgeSnapshot {
  inFlightBinaryBytes: number
  inFlightBinaryHandles: number
  openHandles: number
  openResources: number
  outstandingCredits: number
  pendingRequests: number
}

export interface NativeStream extends AsyncIterableIterator<NativeChunk, NativeResult | undefined> {
  readonly id: string
  close(reason?: string): boolean
}

export interface NativeBridge {
  readonly isDisposed: boolean
  cancel(id: string, reason?: string): boolean
  dispose(): void
  getSnapshot(): NativeBridgeSnapshot
  request(request: NativeRequest, options?: NativeCallOptions): Promise<NativeResult>
  revokeResource(handle: NativeResourceHandle, reason?: string): boolean
  stream(request: NativeRequest, options?: NativeCallOptions): NativeStream
}
