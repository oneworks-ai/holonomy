declare const CRYPTO_CONTEXT_HANDLE: unique symbol

export type CryptoHashAlgorithm = 'sha1' | 'sha256'
export type CryptoHmacAlgorithm = 'sha256'
export type CryptoCipherAlgorithm = 'aes-256-gcm'

export interface CryptoHashContextRequest {
  readonly algorithm: CryptoHashAlgorithm
  readonly kind: 'hash'
}

export interface CryptoHmacContextRequest {
  readonly algorithm: CryptoHmacAlgorithm
  readonly key: Uint8Array
  readonly kind: 'hmac'
}

export interface CryptoCipherContextRequest {
  readonly algorithm: CryptoCipherAlgorithm
  readonly iv: Uint8Array
  readonly key: Uint8Array
  readonly kind: 'cipher' | 'decipher'
}

export type CryptoPrimitiveContextRequest =
  | CryptoCipherContextRequest
  | CryptoHashContextRequest
  | CryptoHmacContextRequest

export interface CryptoPrimitiveProviderFinalResult {
  readonly authenticated?: boolean
  readonly authTag?: Uint8Array
  readonly output: Uint8Array
}

export interface CryptoPrimitiveProvider {
  /**
   * This is a trusted engine-internal provider. Every method must complete within its
   * current call stack and return the declared non-Promise value; providers must never
   * construct or return a Promise or thenable. A host integration that violates this
   * contract by starting asynchronous work owns observing every rejection before return.
   * Implementations must not perform guest-directed filesystem, network, Binder or
   * Keystore I/O and must snapshot any input they retain before returning. Returned byte
   * arrays transfer temporary ownership to the port and may be zeroed after admission.
   */
  readonly createContext: (request: CryptoPrimitiveContextRequest) => unknown
  readonly digest: (context: unknown) => Uint8Array
  /** Adapter-wide close backstop; called exactly once when the port is disposed. */
  readonly dispose: () => void
  readonly disposeContext: (context: unknown) => void
  readonly final: (context: unknown) => CryptoPrimitiveProviderFinalResult
  readonly randomBytes: (size: number) => Uint8Array
  readonly setAAD: (context: unknown, aad: Uint8Array) => void
  readonly setAuthTag: (context: unknown, authTag: Uint8Array) => void
  /** Host-native constant-time primitive. JavaScript wrappers only preflight inputs. */
  readonly timingSafeEqual: (left: Uint8Array, right: Uint8Array) => boolean
  readonly update: (context: unknown, data: Uint8Array) => Uint8Array
}

export interface CryptoPrimitiveLimits {
  readonly maxAadBytes: number
  readonly maxContextBytes: number
  readonly maxContexts: number
  readonly maxHmacKeyBytes: number
  readonly maxInFlightContextBytes: number
  readonly maxCompareBytes: number
  readonly maxRandomBytesPerCall: number
  readonly maxUpdateBytesPerCall: number
}

export interface CryptoPrimitivePortOptions {
  readonly limits?: Partial<CryptoPrimitiveLimits>
  readonly provider: CryptoPrimitiveProvider
}

export interface CryptoPrimitiveContextHandle {
  readonly [CRYPTO_CONTEXT_HANDLE]: true
}

export interface CryptoPrimitiveFinalResult {
  readonly authTag?: Uint8Array
  readonly output: Uint8Array
}

export type CryptoContextStatus = 'active' | 'finalized' | 'released'
