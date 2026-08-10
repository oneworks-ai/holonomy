import { describe, expect, it } from 'vitest'

import { createCryptoSyntheticModule } from '../../src/crypto/node-crypto.js'
import { CryptoPrimitivePort, DEFAULT_CRYPTO_PRIMITIVE_LIMITS } from '../../src/crypto/primitive-port.js'
import { installCryptoRuntime } from '../../src/crypto/runtime-install.js'

import { createTestProvider, overrideProvider } from './fixtures.js'

describe('crypto facade bounded admission', () => {
  it('rejects oversized facade strings before the provider is called', () => {
    const base = createTestProvider()
    let updates = 0
    const port = new CryptoPrimitivePort({
      limits: { maxUpdateBytesPerCall: 2 },
      provider: overrideProvider(base, {
        update: (context, input) => {
          updates += 1
          return base.update(context, input)
        }
      })
    })
    const crypto = createCryptoSyntheticModule(port)
    const hash = crypto.createHash('sha256')
    expect(() => hash.update('abc')).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_RESOURCE_EXHAUSTED'
    }))
    expect(updates).toBe(0)
    expect(hash.update('ab').digest('hex')).toHaveLength(64)
  })

  it('uses captured normalization and byte-length intrinsics after prototype mutation', () => {
    const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'toLowerCase')!
    const charDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'charCodeAt')!
    try {
      Reflect.defineProperty(String.prototype, 'toLowerCase', { value: () => 'unsupported' })
      Reflect.defineProperty(String.prototype, 'charCodeAt', {
        value: () => {
          throw new Error('patched')
        }
      })
      const crypto = createCryptoSyntheticModule(new CryptoPrimitivePort({ provider: createTestProvider() }))
      expect(crypto.createHash('SHA256').update('abc', 'UTF8' as never).digest('hex')).toHaveLength(64)
      expect(() => crypto.createHash('SHA256').update('abc', 'unknown' as never)).toThrowError(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
      )
    } finally {
      Reflect.defineProperty(String.prototype, 'toLowerCase', descriptor)
      Reflect.defineProperty(String.prototype, 'charCodeAt', charDescriptor)
    }
  })

  it('zeroes facade copies after converting provider output', () => {
    const base = createTestProvider()
    let providerOutput: Uint8Array | undefined
    const crypto = createCryptoSyntheticModule(
      new CryptoPrimitivePort({
        provider: overrideProvider(base, {
          update: (context, input) => {
            providerOutput = base.update(context, input)
            return providerOutput
          }
        })
      })
    )
    const output = crypto.createCipheriv('aes-256-gcm', new Uint8Array(32), new Uint8Array(12))
      .update(Uint8Array.of(1, 2, 3))
    expect(output).toHaveLength(3)
    expect(providerOutput).toEqual(new Uint8Array(3))
  })

  it('zeroes cipher output and tags on encoding and tag-copy failures', () => {
    const createFakePort = (
      output: Uint8Array,
      authTag: Uint8Array,
      failTagCopy = false
    ): CryptoPrimitivePort => {
      const limits = { ...DEFAULT_CRYPTO_PRIMITIVE_LIMITS }
      return {
        createContext: () => Object.freeze({}),
        final: () => {
          if (failTagCopy) limits.maxInFlightContextBytes = 15
          return Object.freeze({ authTag, output })
        },
        limits,
        randomBytes: (size: number) => new Uint8Array(size),
        setAAD: () => undefined,
        setAuthTag: () => undefined,
        timingSafeEqual: () => true,
        update: () => output
      } as unknown as CryptoPrimitivePort
    }

    const updateOutput = Uint8Array.of(1, 2, 3)
    const updateCipher = createCryptoSyntheticModule(
      createFakePort(updateOutput, new Uint8Array(16))
    ).createCipheriv('aes-256-gcm', new Uint8Array(32), new Uint8Array(12))
    expect(() => updateCipher.update(Uint8Array.of(1), undefined, 'utf8' as never)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    )
    expect(updateOutput).toEqual(new Uint8Array(3))

    const finalOutput = Uint8Array.of(4, 5)
    const finalTag = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16)
    const finalCipher = createCryptoSyntheticModule(createFakePort(finalOutput, finalTag))
      .createCipheriv('aes-256-gcm', new Uint8Array(32), new Uint8Array(12))
    expect(() => finalCipher.final('utf8' as never)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    )
    expect(finalOutput).toEqual(new Uint8Array(2))
    expect(finalTag).toEqual(new Uint8Array(16))

    const rejectedOutput = Uint8Array.of(6, 7)
    const rejectedTag = new Uint8Array(16)
    rejectedTag[0] = 9
    const rejectedCipher = createCryptoSyntheticModule(
      createFakePort(rejectedOutput, rejectedTag, true)
    ).createCipheriv('aes-256-gcm', new Uint8Array(32), new Uint8Array(12))
    expect(() => rejectedCipher.final()).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_RESOURCE_EXHAUSTED'
    }))
    expect(rejectedOutput).toEqual(new Uint8Array(2))
    expect(rejectedTag).toEqual(new Uint8Array(16))
  })

  it('uses indexed local UTF-8 and internal byte lengths after prototype mutation', () => {
    const pushDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'push')!
    const define = Object.defineProperty
    let byteLengthGetterCalls = 0
    let encodedInput: Uint8Array | undefined
    let digestLength = -1
    let failure: unknown
    class HostileBytes extends Uint8Array {
      override get byteLength(): number {
        byteLengthGetterCalls += 1
        throw new Error('hostile byteLength')
      }
    }
    const fakePort = {
      createContext: () => Object.freeze({}),
      digest: () => new HostileBytes(32),
      limits: DEFAULT_CRYPTO_PRIMITIVE_LIMITS,
      randomBytes: (size: number) => new Uint8Array(size),
      timingSafeEqual: () => true,
      update: (_handle: unknown, input: Uint8Array) => {
        encodedInput = new Uint8Array(input.length)
        for (let index = 0; index < input.length; index += 1) {
          encodedInput[index] = input[index]!
        }
        return new Uint8Array(0)
      }
    } as unknown as CryptoPrimitivePort
    try {
      define(Array.prototype, 'push', {
        configurable: true,
        value: () => {
          throw new Error('patched push')
        }
      })
      const hash = createCryptoSyntheticModule(fakePort).createHash('sha256')
      hash.update('😀')
      digestLength = hash.digest().length
    } catch (error) {
      failure = error
    } finally {
      define(Array.prototype, 'push', pushDescriptor)
    }
    expect(failure).toBeUndefined()
    expect(encodedInput).toEqual(Uint8Array.of(0xF0, 0x9F, 0x98, 0x80))
    expect(digestLength).toBe(32)
    expect(byteLengthGetterCalls).toBe(0)
  })

  it('creates Node and Web UUIDs without the typed-array iterator', () => {
    const base = createTestProvider()
    let providerCalls = 0
    let firstProviderOutput: Uint8Array | undefined
    let secondProviderOutput: Uint8Array | undefined
    const crypto = createCryptoSyntheticModule(
      new CryptoPrimitivePort({
        provider: overrideProvider(base, {
          randomBytes: (size) => {
            const output = base.randomBytes(size)
            if (providerCalls === 0) firstProviderOutput = output
            else secondProviderOutput = output
            providerCalls += 1
            return output
          }
        })
      })
    )
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
    const iteratorDescriptor = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      Symbol.iterator
    )!
    let iteratorCalls = 0
    let nodeUuid = ''
    let webUuid = ''
    let failure: unknown
    try {
      Reflect.defineProperty(typedArrayPrototype, Symbol.iterator, {
        configurable: true,
        value: () => {
          iteratorCalls += 1
          throw new Error('patched typed-array iterator detail')
        }
      })
      nodeUuid = crypto.randomUUID()
      webUuid = crypto.webcrypto.randomUUID()
    } catch (error) {
      failure = error
    } finally {
      Reflect.defineProperty(typedArrayPrototype, Symbol.iterator, iteratorDescriptor)
    }
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(failure).toBeUndefined()
    expect(nodeUuid).toMatch(uuidV4)
    expect(webUuid).toMatch(uuidV4)
    expect(iteratorCalls).toBe(0)
    expect(providerCalls).toBe(2)
    expect(firstProviderOutput).toEqual(new Uint8Array(16))
    expect(secondProviderOutput).toEqual(new Uint8Array(16))
  })

  it('advertises actual limits and fails closed below the Web random-values contract', () => {
    const installed = installCryptoRuntime({
      limits: { maxRandomBytesPerCall: 65_536, maxUpdateBytesPerCall: 128 },
      provider: createTestProvider()
    })
    expect(installed.capabilityDescriptors[0]!.constraints?.['host.crypto.random.max-bytes']).toBe(65_536)
    expect(installed.capabilityDescriptors[1]!.constraints?.['node.crypto.random.max-bytes']).toBe(65_536)
    installed.dispose()
    expect(() =>
      installCryptoRuntime({
        limits: { maxRandomBytesPerCall: 65_535 },
        provider: createTestProvider()
      })
    ).toThrowError(expect.objectContaining({ code: 'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED' }))
  })
})
