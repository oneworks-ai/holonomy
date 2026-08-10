import { RuntimeBuffer } from '../node-compat/buffer.js'

import { inspectBytes, writeBytes, zeroBytes } from './binary-intrinsics.js'
import { cryptoError, invalidArgumentType } from './errors.js'
import { copyBoundedInput, encodeCryptoOutput, normalizeOutputEncoding } from './facade-codec.js'
import type { CryptoInputEncoding, CryptoOutputEncoding } from './facade-codec.js'
import { lowercaseString } from './intrinsics.js'
import type { CryptoPrimitivePort } from './primitive-port.js'

export type CryptoBinaryLike = string | Uint8Array

export const normalizeHashAlgorithm = (
  algorithm: unknown,
  hmac: boolean
): 'sha1' | 'sha256' => {
  if (typeof algorithm !== 'string') return invalidArgumentType()
  const normalized = lowercaseString(algorithm)
  if (normalized === 'sha256') return normalized
  if (!hmac && normalized === 'sha1') return normalized
  throw cryptoError('ERR_CRYPTO_UNKNOWN_HASH')
}

export const normalizeCipherAlgorithm = (algorithm: unknown): 'aes-256-gcm' => {
  if (typeof algorithm !== 'string') return invalidArgumentType()
  if (lowercaseString(algorithm) !== 'aes-256-gcm') return invalidArgumentType()
  return 'aes-256-gcm'
}

export const inputBytes = (
  port: CryptoPrimitivePort,
  value: CryptoBinaryLike,
  encoding: CryptoInputEncoding | undefined,
  maximumBytes = port.limits.maxUpdateBytesPerCall
): Uint8Array => copyBoundedInput(value, encoding, maximumBytes)

export const runtimeBuffer = (bytes: Uint8Array): RuntimeBuffer => {
  const snapshot = inspectBytes(bytes)
  const output = new RuntimeBuffer(snapshot.byteLength)
  writeBytes(output, snapshot.bytes)
  return output
}

export const outputValue = (
  bytes: Uint8Array,
  encoding?: unknown
): RuntimeBuffer | string => {
  try {
    const normalized = normalizeOutputEncoding(encoding)
    return normalized === undefined ? runtimeBuffer(bytes) : encodeCryptoOutput(bytes, normalized)
  } finally {
    zeroBytes(bytes)
  }
}

export const resolveCipherOutputEncoding = (
  data: CryptoBinaryLike,
  inputEncoding: CryptoInputEncoding | undefined,
  outputEncoding: CryptoOutputEncoding | undefined
): CryptoInputEncoding | CryptoOutputEncoding | undefined => {
  if (outputEncoding !== undefined) return outputEncoding
  if (typeof data !== 'string' && inputEncoding !== undefined) return inputEncoding
  return undefined
}
