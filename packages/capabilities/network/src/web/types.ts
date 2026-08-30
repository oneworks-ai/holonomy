import type { NativeBridge } from '@holonomyjs/runtime/native-port/types'

import type { NetworkDiagnosticsSink } from './network-diagnostics-types.js'
import type { WebHeaders } from './web-headers.js'
import type { WebRequest, WebRequestInfo, WebRequestInit } from './web-request.js'
import type { WebResponse } from './web-response.js'

export type NetworkScheme = 'http' | 'https' | 'ws' | 'wss'
export type NetworkPrivatePolicy = 'allow' | 'deny'

export interface NetworkLimits {
  maxChunkBytes: number
  maxConcurrentConnections: number
  maxHeaderBytes: number
  maxHeaders: number
  maxRedirects: number
  maxRequestBodyBytes: number
  maxResponseBodyBytes: number
  maxUrlBytes?: number
  maxWebSocketBufferedBytes: number
  maxWebSocketMessageBytes: number
  socketTimeoutMs?: number
}

export interface NetworkAuthority {
  /** Exact normalized origins. `*` still excludes private network targets by default. */
  allowedOrigins: readonly string[]
  allowedSchemes?: readonly NetworkScheme[]
  limits?: Partial<NetworkLimits>
  privateNetwork?: NetworkPrivatePolicy
}

export interface ResolvedNetworkAuthority {
  readonly allowedOrigins: readonly string[]
  readonly allowedSchemes: readonly NetworkScheme[]
  readonly allowAnyOrigin: boolean
  readonly limits: Readonly<NetworkLimits>
  readonly privateNetwork: NetworkPrivatePolicy
}

export type WebBodyInit = ArrayBuffer | ArrayBufferView | string
export type WebRedirectMode = 'error' | 'follow' | 'manual'

export interface WebFetchInit extends WebRequestInit {
  /** Absolute monotonic deadline in the Native Bridge scheduler time domain. */
  deadlineMs?: number
  redirect?: WebRedirectMode
  signal?: AbortSignal
  timeoutMs?: number
}

export interface WebNetworkRuntimeOptions {
  authority: NetworkAuthority
  bridge: NativeBridge
  constructors?: {
    AbortController?: typeof globalThis.AbortController
    AbortSignal?: typeof globalThis.AbortSignal
  }
  /** Trusted capability hook. It runs before transport and around response continuations. */
  capability?: WebNetworkCapabilityHooksV1
  diagnostics?: NetworkDiagnosticsSink
  /** Zero disables body retention. Trusted debuggers may opt into a bounded base64 side channel. */
  diagnosticsBodyLimitBytes?: number
  /** Trusted monotonic milliseconds used only for diagnostics ordering. */
  diagnosticsNow?: () => number
}

export interface WebNetworkCapabilityRequestV1 {
  readonly body?: Uint8Array
  readonly headers: NetworkHeaderEntries
  readonly hop: number
  readonly logicalRequestId: string
  readonly method: string
  readonly url: string
}

export interface WebNetworkCapabilityAdmissionV1 {
  readonly bindingId: string
  readonly generation: number
  readonly resourceType: 'network.response'
}

export interface WebNetworkCapabilityResponseV1 {
  readonly admission: WebNetworkCapabilityAdmissionV1
  readonly metadata: Readonly<{
    headers: NetworkHeaderEntries
    hop: number
    logicalRequestId: string
    redirected: boolean
    source: 'mock' | 'real'
    status: number
    statusText: string
    url: string
  }>
}

export interface WebNetworkCapabilityHooksV1 {
  authorizeRedirect(
    from: WebNetworkCapabilityRequestV1,
    to: WebNetworkCapabilityRequestV1,
    status: 301 | 302 | 303 | 307 | 308,
    admission: WebNetworkCapabilityAdmissionV1
  ): Promise<void>
  authorizeRequest(request: WebNetworkCapabilityRequestV1): Promise<WebNetworkCapabilityAdmissionV1>
  authorizeResponse(
    response: WebNetworkCapabilityResponseV1,
    member:
      | 'Response.arrayBuffer'
      | 'Response.bytes'
      | 'Response.clone'
      | 'Response.json'
      | 'Response.metadata'
      | 'Response.text'
  ): Promise<unknown> | unknown
  cloneResponse(admission: WebNetworkCapabilityAdmissionV1): WebNetworkCapabilityAdmissionV1
  releaseResponse(admission: WebNetworkCapabilityAdmissionV1): void
}

export type NetworkHeaderEntries = readonly (readonly [string, string])[]
export type {
  NetworkDiagnosticsEvent,
  NetworkDiagnosticsResponse,
  NetworkDiagnosticsSink,
  NetworkDiagnosticsSource
} from './network-diagnostics-types.js'
export type {
  NetworkMockBodyMatch,
  NetworkMockEntryMatch,
  NetworkMockRequest,
  NetworkMockRule,
  NetworkMockRuleSet,
  NetworkMockRuleSetSnapshot
} from './network-mock-types.js'

export interface WebNetworkRuntime {
  readonly AbortController: typeof globalThis.AbortController
  readonly AbortSignal: typeof globalThis.AbortSignal
  readonly Headers: typeof WebHeaders
  readonly Request: typeof WebRequest
  readonly Response: typeof WebResponse
  dispose(): void
  fetch(input: WebRequestInfo, init?: WebFetchInit): Promise<WebResponse>
}

export interface WebNetworkGlobalTarget {
  AbortController?: typeof globalThis.AbortController
  AbortSignal?: typeof globalThis.AbortSignal
  Headers?: typeof WebHeaders
  Request?: typeof WebRequest
  Response?: typeof WebResponse
  fetch?: (input: WebRequestInfo, init?: WebFetchInit) => Promise<WebResponse>
}

export interface WebNetworkInstallOptions {
  preserveExistingAbortGlobals?: boolean
}

export interface WebNetworkInstalledGlobals {
  restore(): void
  runtime: WebNetworkRuntime
}
