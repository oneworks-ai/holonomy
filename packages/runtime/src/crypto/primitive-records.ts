import type { TypedArraySnapshot } from './binary-intrinsics.js'
import type { CryptoContextStatus, CryptoPrimitiveContextRequest } from './types.js'

export type ContextAlgorithm = 'aes-256-gcm' | 'sha1' | 'sha256'

export interface ContextRecord {
  aadBytes: number
  readonly algorithm: ContextAlgorithm
  authTagSet: boolean
  dataBytes: number
  dataStarted: boolean
  readonly kind: CryptoPrimitiveContextRequest['kind']
  outputBytes: number
  providerContext: object | undefined
  retainedBytes: number
  state: CryptoContextStatus
}

export type InspectedContextRequest =
  | {
    readonly algorithm: 'sha1' | 'sha256'
    readonly kind: 'hash'
  }
  | {
    readonly algorithm: 'sha256'
    readonly key: TypedArraySnapshot
    readonly kind: 'hmac'
  }
  | {
    readonly algorithm: 'aes-256-gcm'
    readonly iv: TypedArraySnapshot
    readonly key: TypedArraySnapshot
    readonly kind: 'cipher' | 'decipher'
  }
