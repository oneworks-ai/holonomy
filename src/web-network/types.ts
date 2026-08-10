import type { NativeBridge } from '../native-port/types.js'

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
  maxWebSocketBufferedBytes: number
  maxWebSocketMessageBytes: number
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
