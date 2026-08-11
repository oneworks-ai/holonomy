import type { NetworkHeaderEntries } from './types.js'

export type NetworkDiagnosticsSource = 'mock' | 'real'

export interface NetworkDiagnosticsResponse {
  readonly headers: NetworkHeaderEntries
  readonly source: NetworkDiagnosticsSource
  readonly status: number
  readonly statusText: string
  readonly url: string
}

interface Sourced {
  source: NetworkDiagnosticsSource
}

export type NetworkDiagnosticsEvent =
  | Readonly<{
    headers: NetworkHeaderEntries
    hasPostData: boolean
    hop: number
    method: string
    redirectResponse?: NetworkDiagnosticsResponse
    requestId: string
    timestampMs: number
    type: 'requestWillBeSent'
    url: string
  }>
  | Readonly<
    Sourced & {
      headers: NetworkHeaderEntries
      hop: number
      requestId: string
      status: number
      statusText: string
      timestampMs: number
      type: 'responseReceived'
      url: string
    }
  >
  | Readonly<
    Sourced & {
      bodyUnavailable?: boolean
      dataBase64?: string
      dataLength: number
      requestId: string
      timestampMs: number
      type: 'dataReceived'
    }
  >
  | Readonly<
    Sourced & {
      requestId: string
      timestampMs: number
      totalBytes: number
      type: 'loadingFinished'
    }
  >
  | Readonly<
    Sourced & {
      cancelled: boolean
      code: string
      requestId: string
      timestampMs: number
      type: 'loadingFailed'
    }
  >

export interface NetworkDiagnosticsSink {
  emit(event: NetworkDiagnosticsEvent): void
}
