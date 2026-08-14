import type { NetworkHeaderEntries } from './types.js'

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
