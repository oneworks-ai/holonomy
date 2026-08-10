export type RuntimeCryptoErrorCode =
  | 'ERR_INVALID_ARG_TYPE'
  | 'ERR_OUT_OF_RANGE'
  | 'ERR_CRYPTO_UNKNOWN_HASH'
  | 'ERR_CRYPTO_INVALID_KEYLEN'
  | 'ERR_CRYPTO_INVALID_IV'
  | 'ERR_CRYPTO_INVALID_AUTH_TAG'
  | 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH'
  | 'ERR_CRYPTO_HASH_FINALIZED'
  | 'ERR_CRYPTO_INVALID_STATE'
  | 'ERR_CRYPTO_RANDOM_UNAVAILABLE'
  | 'ERR_MOBILE_RUNTIME_RESOURCE_EXHAUSTED'
  | 'ERR_MOBILE_RUNTIME_CRYPTO_DISPOSED'
  | 'ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED'

const ERROR_MESSAGES: Readonly<Record<RuntimeCryptoErrorCode, string>> = Object.freeze({
  ERR_INVALID_ARG_TYPE: 'The supplied crypto argument has an invalid type',
  ERR_OUT_OF_RANGE: 'The supplied crypto argument is outside the supported range',
  ERR_CRYPTO_UNKNOWN_HASH: 'The requested hash algorithm is not supported',
  ERR_CRYPTO_INVALID_KEYLEN: 'The supplied crypto key has an invalid length',
  ERR_CRYPTO_INVALID_IV: 'The supplied crypto IV has an invalid length',
  ERR_CRYPTO_INVALID_AUTH_TAG: 'The supplied crypto authentication tag is invalid',
  ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH: 'Input buffers must have the same byte length',
  ERR_CRYPTO_HASH_FINALIZED: 'Digest has already been called',
  ERR_CRYPTO_INVALID_STATE: 'The crypto context is in an invalid state',
  ERR_CRYPTO_RANDOM_UNAVAILABLE: 'Cryptographic random data is unavailable',
  ERR_MOBILE_RUNTIME_RESOURCE_EXHAUSTED: 'The mobile runtime crypto quota was exceeded',
  ERR_MOBILE_RUNTIME_CRYPTO_DISPOSED: 'The mobile runtime crypto resource was disposed',
  ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED: 'The mobile runtime crypto operation failed'
})

interface CryptoErrorWithCode {
  readonly code: RuntimeCryptoErrorCode
}

export class RuntimeCryptoError extends Error implements CryptoErrorWithCode {
  readonly code: RuntimeCryptoErrorCode

  constructor(code: RuntimeCryptoErrorCode) {
    super(ERROR_MESSAGES[code])
    this.code = code
    this.name = 'RuntimeCryptoError'
  }
}

export class RuntimeCryptoTypeError extends TypeError implements CryptoErrorWithCode {
  readonly code = 'ERR_INVALID_ARG_TYPE' as const

  constructor() {
    super(ERROR_MESSAGES.ERR_INVALID_ARG_TYPE)
    this.name = 'TypeError'
  }
}

export class RuntimeCryptoRangeError extends RangeError implements CryptoErrorWithCode {
  readonly code = 'ERR_OUT_OF_RANGE' as const

  constructor() {
    super(ERROR_MESSAGES.ERR_OUT_OF_RANGE)
    this.name = 'RangeError'
  }
}

export const cryptoError = (code: RuntimeCryptoErrorCode): RuntimeCryptoError => new RuntimeCryptoError(code)

export const invalidArgumentType = (): never => {
  throw new RuntimeCryptoTypeError()
}

export const outOfRange = (): never => {
  throw new RuntimeCryptoRangeError()
}
