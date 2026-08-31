import { zeroBytes } from './binary-intrinsics.js'
import { freeze, objectKeys } from './intrinsics.js'
import { createCipher } from './node-cipher.js'
import type { RuntimeCipherGcm, RuntimeDecipherGcm } from './node-cipher.js'
import { runtimeBuffer } from './node-crypto-codec.js'
import type { CryptoBinaryLike } from './node-crypto-codec.js'
import { createHash, createHmac } from './node-hash.js'
import type { RuntimeHash, RuntimeHmac } from './node-hash.js'
import type { CryptoPrimitivePort } from './primitive-port.js'
import { randomUUID } from './random.js'
import { createRuntimeWebCrypto } from './web-crypto.js'
import type { RuntimeWebCrypto } from './web-crypto.js'

export type { CryptoInputEncoding, CryptoOutputEncoding } from './facade-codec.js'
export type { RuntimeCipherGcm, RuntimeDecipherGcm } from './node-cipher.js'
export type { CryptoBinaryLike } from './node-crypto-codec.js'
export type { RuntimeHash, RuntimeHmac } from './node-hash.js'

export interface CryptoSyntheticModule {
  readonly createCipheriv: (
    algorithm: string,
    key: Uint8Array,
    iv: Uint8Array
  ) => RuntimeCipherGcm
  readonly createDecipheriv: (
    algorithm: string,
    key: Uint8Array,
    iv: Uint8Array
  ) => RuntimeDecipherGcm
  readonly createHash: (algorithm: string) => RuntimeHash
  readonly createHmac: (algorithm: string, key: CryptoBinaryLike) => RuntimeHmac
  readonly default: Readonly<Omit<CryptoSyntheticModule, 'default'>>
  readonly randomBytes: (size: number) => import('../node-compat/buffer.js').RuntimeBuffer
  readonly randomUUID: () => string
  readonly timingSafeEqual: (left: Uint8Array, right: Uint8Array) => boolean
  readonly webcrypto: RuntimeWebCrypto
}

export interface CryptoSyntheticModuleBinding {
  readonly descriptor: Readonly<{ readonly exportNames: readonly string[] }>
  readonly namespace: CryptoSyntheticModule
}

export const createCryptoSyntheticModule = (
  port: CryptoPrimitivePort
): CryptoSyntheticModule => {
  const webcrypto = createRuntimeWebCrypto(port)
  const namespace = {
    createCipheriv: (algorithm: string, key: Uint8Array, iv: Uint8Array) =>
      createCipher(port, false, algorithm, key, iv),
    createDecipheriv: (algorithm: string, key: Uint8Array, iv: Uint8Array) =>
      createCipher(port, true, algorithm, key, iv),
    createHash: (algorithm: string) => createHash(port, algorithm),
    createHmac: (algorithm: string, key: CryptoBinaryLike) => createHmac(port, algorithm, key),
    randomBytes: (size: number) => {
      const bytes = port.randomBytes(size)
      try {
        return runtimeBuffer(bytes)
      } finally {
        zeroBytes(bytes)
      }
    },
    randomUUID: () => randomUUID(port),
    timingSafeEqual: (left: Uint8Array, right: Uint8Array) => port.timingSafeEqual(left, right),
    webcrypto
  }
  const frozenNamespace = freeze(namespace)
  return freeze({ ...frozenNamespace, default: frozenNamespace })
}

export const createCryptoSyntheticModuleBinding = (
  port: CryptoPrimitivePort
): CryptoSyntheticModuleBinding => {
  const namespace = createCryptoSyntheticModule(port)
  return freeze({
    descriptor: freeze({ exportNames: freeze(objectKeys(namespace)) }),
    namespace
  })
}
