import { describe, expect, it } from 'vitest'

import { createCryptoSyntheticModule } from '../../src/crypto/node-crypto.js'

import { createTestPort, createTestProvider, overrideProvider } from './fixtures.js'

const codeOf = (operation: () => unknown): string => {
  try {
    operation()
  } catch (error) {
    return (error as { code?: string }).code ?? 'missing'
  }
  return 'none'
}

describe('stable crypto error surface', () => {
  it('covers every required-now stable error code without native payloads', () => {
    const invalidType = createTestPort()
    const outOfRange = createTestPort()
    const unknownHash = createCryptoSyntheticModule(createTestPort())
    const invalidKey = createCryptoSyntheticModule(createTestPort())
    const invalidIv = createCryptoSyntheticModule(createTestPort())
    const authPort = createTestPort()
    const authHandle = authPort.createContext({
      algorithm: 'aes-256-gcm',
      iv: new Uint8Array(12),
      key: new Uint8Array(32),
      kind: 'decipher'
    })
    const timing = createTestPort()
    const finalized = createTestPort()
    const finalizedHash = finalized.createContext({ algorithm: 'sha1', kind: 'hash' })
    finalized.digest(finalizedHash)
    const invalidState = createTestPort()
    const cipher = invalidState.createContext({
      algorithm: 'aes-256-gcm',
      iv: new Uint8Array(12),
      key: new Uint8Array(32),
      kind: 'cipher'
    })
    const randomUnavailable = createTestPort(
      undefined,
      overrideProvider(createTestProvider(), {
        randomBytes: () => {
          throw new Error('native entropy secret')
        }
      })
    )
    const resource = createTestPort()
    const disposed = createTestPort()
    disposed.dispose()
    const operationFailed = createTestPort(
      undefined,
      overrideProvider(createTestProvider(), {
        timingSafeEqual: () => {
          throw new Error('native comparison secret')
        }
      })
    )

    const actual = [
      codeOf(() => invalidType.randomBytes('1' as unknown as number)),
      codeOf(() => outOfRange.randomBytes(-1)),
      codeOf(() => unknownHash.createHash('md5')),
      codeOf(() =>
        invalidKey.createCipheriv(
          'aes-256-gcm',
          new Uint8Array(31),
          new Uint8Array(12)
        )
      ),
      codeOf(() =>
        invalidIv.createCipheriv(
          'aes-256-gcm',
          new Uint8Array(32),
          new Uint8Array(11)
        )
      ),
      codeOf(() => authPort.setAuthTag(authHandle, new Uint8Array(15))),
      codeOf(() => timing.timingSafeEqual(new Uint8Array(1), new Uint8Array(2))),
      codeOf(() => finalized.digest(finalizedHash)),
      codeOf(() => invalidState.digest(cipher)),
      codeOf(() => randomUnavailable.randomBytes(1)),
      codeOf(() => resource.randomBytes(65_537)),
      codeOf(() => disposed.randomBytes(1)),
      codeOf(() => operationFailed.timingSafeEqual(Uint8Array.of(1), Uint8Array.of(1)))
    ]
    expect(actual).toEqual([
      'ERR_INVALID_ARG_TYPE',
      'ERR_OUT_OF_RANGE',
      'ERR_CRYPTO_UNKNOWN_HASH',
      'ERR_CRYPTO_INVALID_KEYLEN',
      'ERR_CRYPTO_INVALID_IV',
      'ERR_CRYPTO_INVALID_AUTH_TAG',
      'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH',
      'ERR_CRYPTO_HASH_FINALIZED',
      'ERR_CRYPTO_INVALID_STATE',
      'ERR_CRYPTO_RANDOM_UNAVAILABLE',
      'ERR_HOLONOMY_RESOURCE_EXHAUSTED',
      'ERR_HOLONOMY_CRYPTO_DISPOSED',
      'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'
    ])
  })
})
