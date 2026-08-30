import type { NativeBridge, NativePort } from '../native-port/types.js'

export interface HttpServerLimits {
  readonly maxChunkBytes: number
  readonly maxConnections: number
  readonly maxHeaderBytes: number
  readonly maxHeaders: number
  readonly maxRequestBodyBytes: number
  readonly maxResponseBodyBytes: number
  readonly maxWebSocketBufferedBytes: number
  readonly maxWebSocketMessageBytes: number
}

export const DEFAULT_HTTP_SERVER_LIMITS: Readonly<HttpServerLimits> = Object.freeze({
  maxChunkBytes: 64 * 1024,
  maxConnections: 32,
  maxHeaderBytes: 32 * 1024,
  maxHeaders: 128,
  maxRequestBodyBytes: 8 * 1024 * 1024,
  maxResponseBodyBytes: 16 * 1024 * 1024,
  maxWebSocketBufferedBytes: 512 * 1024,
  maxWebSocketMessageBytes: 256 * 1024
})

export interface HttpServerAddress {
  readonly address: string
  readonly family: 'IPv4'
  readonly port: number
}

export type HttpIncomingHeaders = Readonly<Record<string, string | readonly string[] | undefined>>

export interface HttpServerRuntimeOptions {
  readonly bridge: NativeBridge
  readonly limits?: Partial<HttpServerLimits>
}

export interface MemoryHttpServerProviderOptions {
  readonly capability?: string
  readonly limits?: Partial<HttpServerLimits>
}

export interface VirtualHttpRequest {
  readonly body?: string | Uint8Array
  readonly headers?: Readonly<Record<string, string | readonly string[]>>
  readonly method?: string
  readonly url?: string
}

export interface VirtualHttpResponse {
  readonly body: Uint8Array
  readonly headers: Readonly<Record<string, string | readonly string[]>>
  readonly statusCode: number
  readonly statusMessage?: string
}

export interface VirtualWebSocketRequest extends Omit<VirtualHttpRequest, 'body'> {
  readonly head?: Uint8Array
}

export interface VirtualWebSocketPeer {
  close(code?: number, reason?: string): void
  next(): Promise<IteratorResult<{ readonly data: Uint8Array; readonly isBinary: boolean }>>
  send(data: string | Uint8Array, isBinary?: boolean): void
}

export interface MemoryHttpServerProviderContract extends NativePort {
  request(address: HttpServerAddress, request: VirtualHttpRequest): Promise<VirtualHttpResponse>
  websocket(address: HttpServerAddress, request?: VirtualWebSocketRequest): Promise<VirtualWebSocketPeer>
}
