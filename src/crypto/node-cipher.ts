import { inspectBytes, zeroBytes } from './binary-intrinsics.js'
import { cryptoError } from './errors.js'
import { inspectBoundedBytes } from './facade-codec.js'
import type { CryptoInputEncoding, CryptoOutputEncoding } from './facade-codec.js'
import { freeze } from './intrinsics.js'
import {
  inputBytes,
  normalizeCipherAlgorithm,
  outputValue,
  resolveCipherOutputEncoding,
  runtimeBuffer
} from './node-crypto-codec.js'
import type { CryptoBinaryLike } from './node-crypto-codec.js'
import type { CryptoPrimitivePort } from './primitive-port.js'
import type { CryptoPrimitiveContextHandle } from './types.js'

export interface RuntimeCipherGcm {
  final(): import('../node-compat/buffer.js').RuntimeBuffer
  final(outputEncoding: CryptoOutputEncoding): string
  getAuthTag(): import('../node-compat/buffer.js').RuntimeBuffer
  setAAD(aad: CryptoBinaryLike): RuntimeCipherGcm
  update(
    data: CryptoBinaryLike,
    inputEncoding?: CryptoInputEncoding,
    outputEncoding?: CryptoOutputEncoding
  ): import('../node-compat/buffer.js').RuntimeBuffer | string
}

export interface RuntimeDecipherGcm {
  final(): import('../node-compat/buffer.js').RuntimeBuffer
  final(outputEncoding: CryptoOutputEncoding): string
  setAAD(aad: CryptoBinaryLike): RuntimeDecipherGcm
  setAuthTag(authTag: Uint8Array): RuntimeDecipherGcm
  update(
    data: CryptoBinaryLike,
    inputEncoding?: CryptoInputEncoding,
    outputEncoding?: CryptoOutputEncoding
  ): import('../node-compat/buffer.js').RuntimeBuffer | string
}

export function createCipher(
  port: CryptoPrimitivePort,
  decrypt: false,
  algorithm: unknown,
  key: Uint8Array,
  iv: Uint8Array
): RuntimeCipherGcm
export function createCipher(
  port: CryptoPrimitivePort,
  decrypt: true,
  algorithm: unknown,
  key: Uint8Array,
  iv: Uint8Array
): RuntimeDecipherGcm
export function createCipher(
  port: CryptoPrimitivePort,
  decrypt: boolean,
  algorithm: unknown,
  key: Uint8Array,
  iv: Uint8Array
): RuntimeCipherGcm | RuntimeDecipherGcm {
  const normalized = normalizeCipherAlgorithm(algorithm)
  const keySnapshot = inspectBytes(key)
  const ivSnapshot = inspectBytes(iv)
  if (keySnapshot.byteLength !== 32) throw cryptoError('ERR_CRYPTO_INVALID_KEYLEN')
  if (ivSnapshot.byteLength !== 12) throw cryptoError('ERR_CRYPTO_INVALID_IV')
  const keyBytes = inspectBoundedBytes(key, port.limits.maxInFlightContextBytes)
  const ivBytes = inspectBoundedBytes(iv, port.limits.maxInFlightContextBytes)
  let handle: CryptoPrimitiveContextHandle
  try {
    handle = port.createContext({
      algorithm: normalized,
      iv: ivBytes,
      key: keyBytes,
      kind: decrypt ? 'decipher' : 'cipher'
    })
  } finally {
    zeroBytes(keyBytes)
    zeroBytes(ivBytes)
  }
  let authTag: Uint8Array | undefined
  const update = (
    data: CryptoBinaryLike,
    inputEncoding?: CryptoInputEncoding,
    outputEncoding?: CryptoOutputEncoding
  ): import('../node-compat/buffer.js').RuntimeBuffer | string => {
    const input = inputBytes(port, data, inputEncoding)
    let output: Uint8Array
    try {
      output = port.update(handle, input)
    } finally {
      zeroBytes(input)
    }
    return outputValue(output, resolveCipherOutputEncoding(data, inputEncoding, outputEncoding))
  }
  const final = (encoding?: CryptoOutputEncoding) => {
    const result = port.final(handle)
    let outputOwned = true
    let tagCopy: Uint8Array | undefined
    try {
      tagCopy = result.authTag === undefined
        ? undefined
        : inspectBoundedBytes(result.authTag, port.limits.maxInFlightContextBytes)
      outputOwned = false
      const output = outputValue(result.output, encoding)
      authTag = tagCopy
      tagCopy = undefined
      return output
    } finally {
      if (outputOwned) zeroBytes(result.output)
      zeroBytes(result.authTag)
      zeroBytes(tagCopy)
    }
  }
  const setAAD = (aad: CryptoBinaryLike): RuntimeCipherGcm | RuntimeDecipherGcm => {
    const input = inputBytes(port, aad, undefined, port.limits.maxAadBytes)
    try {
      port.setAAD(handle, input)
    } finally {
      zeroBytes(input)
    }
    return api
  }
  let api: RuntimeCipherGcm | RuntimeDecipherGcm
  api = decrypt
    ? freeze({
      final,
      setAAD,
      setAuthTag: (tag: Uint8Array) => {
        const tagSnapshot = inspectBytes(tag)
        if (tagSnapshot.byteLength !== 16) throw cryptoError('ERR_CRYPTO_INVALID_AUTH_TAG')
        const input = inspectBoundedBytes(tag, port.limits.maxInFlightContextBytes)
        try {
          port.setAuthTag(handle, input)
        } finally {
          zeroBytes(input)
        }
        return api
      },
      update
    }) as RuntimeDecipherGcm
    : freeze({
      final,
      getAuthTag: () => {
        if (authTag === undefined) throw cryptoError('ERR_CRYPTO_INVALID_STATE')
        return runtimeBuffer(authTag)
      },
      setAAD,
      update
    }) as RuntimeCipherGcm
  return api
}
