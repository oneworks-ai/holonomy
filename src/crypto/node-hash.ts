import { zeroBytes } from './binary-intrinsics.js'
import { cryptoError } from './errors.js'
import type { CryptoInputEncoding, CryptoOutputEncoding } from './facade-codec.js'
import { freeze } from './intrinsics.js'
import { inputBytes, normalizeHashAlgorithm, outputValue } from './node-crypto-codec.js'
import type { CryptoBinaryLike } from './node-crypto-codec.js'
import type { CryptoPrimitivePort } from './primitive-port.js'
import type { CryptoPrimitiveContextHandle } from './types.js'

export interface RuntimeHash {
  digest(): import('../node-compat/buffer.js').RuntimeBuffer
  digest(encoding: CryptoOutputEncoding): string
  update(data: CryptoBinaryLike, inputEncoding?: CryptoInputEncoding): RuntimeHash
}

export interface RuntimeHmac {
  digest(): import('../node-compat/buffer.js').RuntimeBuffer
  digest(encoding: CryptoOutputEncoding): string
  update(data: CryptoBinaryLike, inputEncoding?: CryptoInputEncoding): RuntimeHmac
}

export const createHash = (port: CryptoPrimitivePort, algorithm: unknown): RuntimeHash => {
  const normalized = normalizeHashAlgorithm(algorithm, false)
  const handle = port.createContext({ algorithm: normalized, kind: 'hash' })
  const hash = freeze({
    digest: (encoding?: CryptoOutputEncoding) => outputValue(port.digest(handle), encoding),
    update: (data: CryptoBinaryLike, encoding?: CryptoInputEncoding) => {
      const input = inputBytes(port, data, encoding)
      try {
        port.update(handle, input)
      } finally {
        zeroBytes(input)
      }
      return hash
    }
  }) as RuntimeHash
  return hash
}

export const createHmac = (
  port: CryptoPrimitivePort,
  algorithm: unknown,
  key: CryptoBinaryLike
): RuntimeHmac => {
  const normalized = normalizeHashAlgorithm(algorithm, true)
  if (normalized !== 'sha256') throw cryptoError('ERR_CRYPTO_UNKNOWN_HASH')
  const keyBytes = inputBytes(port, key, undefined, port.limits.maxHmacKeyBytes)
  let handle: CryptoPrimitiveContextHandle
  try {
    handle = port.createContext({ algorithm: normalized, key: keyBytes, kind: 'hmac' })
  } finally {
    zeroBytes(keyBytes)
  }
  const hmac = freeze({
    digest: (encoding?: CryptoOutputEncoding) => outputValue(port.digest(handle), encoding),
    update: (data: CryptoBinaryLike, encoding?: CryptoInputEncoding) => {
      const input = inputBytes(port, data, encoding)
      try {
        port.update(handle, input)
      } finally {
        zeroBytes(input)
      }
      return hmac
    }
  }) as RuntimeHmac
  return hmac
}
