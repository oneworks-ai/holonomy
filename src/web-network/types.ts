import type { NativeBridge } from '../native-port/types.js'

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
  diagnostics?: NetworkDiagnosticsSink
  /** Zero disables body retention. Trusted debuggers may opt into a bounded base64 side channel. */
  diagnosticsBodyLimitBytes?: number
  /** Trusted monotonic milliseconds used only for diagnostics ordering. */
  diagnosticsNow?: () => number
}

export type NetworkHeaderEntries = readonly (readonly [string, string])[]
export type {
  NetworkDiagnosticsEvent,
  NetworkDiagnosticsResponse,
  NetworkDiagnosticsSink,
  NetworkDiagnosticsSource
} from './network-diagnostics-types.js'

export interface NetworkMockBodyMatch {
  kind: 'base64' | 'empty' | 'json' | 'jsonSubset' | 'sha256' | 'utf8'
  value?: unknown
}

export interface NetworkMockEntryMatch {
  absent?: readonly string[]
  entries: NetworkHeaderEntries
  mode: 'exact' | 'subset'
}

export interface NetworkMockRule {
  action:
    | {
      body?: { chunks?: readonly string[]; kind: 'base64' | 'json' | 'utf8'; value?: unknown }
      delayMs?: number
      headers?: NetworkHeaderEntries
      status: number
      type: 'respond'
    }
    | { code: 'connection_refused' | 'timeout' | 'unavailable'; delayMs?: number; type: 'fail' }
    | { type: 'passthrough' }
  id: string
  lifetime?: { expiresAt?: string; maxMatches?: number }
  match: {
    body?: NetworkMockBodyMatch
    headers?: NetworkMockEntryMatch
    method?: string
    origin?: string
    path?: { op: 'exact' | 'prefix'; value: string }
    query?: NetworkMockEntryMatch
  }
  priority: number
  /** Assigned by the trusted rule store; ignored on input. */
  sequence?: number
}

export interface NetworkMockRuleSet {
  mode: 'failClosed' | 'passthrough'
  rules: readonly NetworkMockRule[]
}

export interface NetworkMockRuleSetSnapshot extends NetworkMockRuleSet {
  revision: string
}

export interface NetworkMockRequest {
  body: Uint8Array
  /** Original admitted length when matching uses a bounded body prefix or no contiguous copy. */
  bodyLength?: number
  bodySha256?: string
  headers: NetworkHeaderEntries
  /** Trusted provider digests for sensitive header values; plaintext is never copied into rules. */
  sensitiveHeaderSha256?: NetworkHeaderEntries
  method: string
  url: string
}

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
