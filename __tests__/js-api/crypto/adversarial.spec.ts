import { describe, expect, it } from 'vitest'

import { CryptoPrimitivePort } from '../../../src/crypto/primitive-port.js'

import { createTestPort, createTestProvider, overrideProvider } from './fixtures.js'

describe('crypto adversarial admission', () => {
  it('does not invoke guest option or provider getters', () => {
    let optionGetterCalled = false
    const options = Object.create(null) as Record<string, unknown>
    Object.defineProperty(options, 'provider', {
      enumerable: true,
      get: () => {
        optionGetterCalled = true
        return createTestProvider()
      }
    })
    expect(() => new CryptoPrimitivePort(options as never)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    )
    expect(optionGetterCalled).toBe(false)

    let providerGetterCalled = false
    const provider = Object.create(null) as Record<string, unknown>
    Object.defineProperty(provider, 'createContext', {
      enumerable: true,
      get: () => {
        providerGetterCalled = true
        return () => Object.freeze({})
      }
    })
    expect(() => new CryptoPrimitivePort({ provider } as never)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    )
    expect(providerGetterCalled).toBe(false)
  })

  it('binds a strict provider surface once and ignores later method mutation', () => {
    const base = createTestProvider()
    const provider = {
      createContext: base.createContext,
      digest: base.digest,
      dispose: base.dispose,
      disposeContext: base.disposeContext,
      final: base.final,
      randomBytes: base.randomBytes,
      setAAD: base.setAAD,
      setAuthTag: base.setAuthTag,
      timingSafeEqual: base.timingSafeEqual,
      update: base.update
    }
    const port = new CryptoPrimitivePort({ provider })
    provider.randomBytes = () => {
      throw new Error('mutated provider surface')
    }
    expect(port.randomBytes(4)).toHaveLength(4)

    expect(() =>
      new CryptoPrimitivePort({
        provider: { ...provider, extra: () => undefined } as never
      })
    ).toThrowError(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
  })

  it('uses typed-array internal slots instead of subclass properties for input and output', () => {
    let byteLengthGetterCalls = 0
    class HostileBytes extends Uint8Array {
      override get byteLength(): number {
        byteLengthGetterCalls += 1
        throw new Error('guest getter')
      }
    }

    const port = createTestPort()
    const hash = port.createContext({ algorithm: 'sha256', kind: 'hash' })
    port.update(hash, new HostileBytes([0x61, 0x62, 0x63]))
    expect(port.digest(hash)).toHaveLength(32)

    const provider = overrideProvider(createTestProvider(), {
      randomBytes: size => new HostileBytes(size)
    })
    expect(createTestPort(undefined, provider).randomBytes(4)).toEqual(new Uint8Array(4))
    expect(byteLengthGetterCalls).toBe(0)
  })

  it('rejects Proxy, SharedArrayBuffer, resizable and detached backing stores', () => {
    const port = createTestPort()
    const hash = port.createContext({ algorithm: 'sha256', kind: 'hash' })
    let proxyGetterCalled = false
    const proxy = new Proxy(new Uint8Array(1), {
      get: () => {
        proxyGetterCalled = true
        return 1
      }
    })
    expect(() => port.update(hash, proxy)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    )
    expect(proxyGetterCalled).toBe(false)

    if (typeof SharedArrayBuffer !== 'undefined') {
      expect(() => port.update(hash, new Uint8Array(new SharedArrayBuffer(1)))).toThrowError(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
      )
    }

    const ResizableArrayBuffer = ArrayBuffer as unknown as new(
      byteLength: number,
      options: { maxByteLength: number }
    ) => ArrayBuffer
    try {
      const resizable = new ResizableArrayBuffer(1, { maxByteLength: 2 })
      if ((resizable as ArrayBuffer & { resizable?: boolean }).resizable === true) {
        expect(() => port.update(hash, new Uint8Array(resizable))).toThrowError(
          expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
        )
      }
    } catch {
      // The engine does not implement resizable ArrayBuffer.
    }

    if (typeof structuredClone === 'function') {
      const backing = new ArrayBuffer(1)
      const detached = new Uint8Array(backing)
      structuredClone(backing, { transfer: [backing] })
      expect(() => port.update(hash, detached)).toThrowError(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
      )
    }

    port.update(hash, Uint8Array.of(1))
    expect(port.digest(hash)).toHaveLength(32)
  })

  it('maps hostile provider bytes and native messages to stable redacted failures', () => {
    const proxyOutput = new Proxy(new Uint8Array(4), {})
    const proxyPort = createTestPort(
      undefined,
      overrideProvider(createTestProvider(), {
        randomBytes: () => proxyOutput
      })
    )
    expect(() => proxyPort.randomBytes(4)).toThrowError(expect.objectContaining({
      code: 'ERR_CRYPTO_RANDOM_UNAVAILABLE',
      message: 'Cryptographic random data is unavailable'
    }))

    const base = createTestProvider()
    const throwing = createTestPort(
      undefined,
      overrideProvider(base, {
        update: () => {
          throw new Error('key=secret plaintext=secret native=secret')
        }
      })
    )
    const hash = throwing.createContext({ algorithm: 'sha256', kind: 'hash' })
    expect(() => throwing.update(hash, Uint8Array.of(1))).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED',
      message: 'The Holonomy Runtime crypto operation failed'
    }))
  })

  it('survives post-import monkeypatches of captured allocation helpers', () => {
    const freezeDescriptor = Object.getOwnPropertyDescriptor(Object, 'freeze')!
    const setAddDescriptor = Object.getOwnPropertyDescriptor(Set.prototype, 'add')!
    const arrayPushDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'push')!
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
    const typedSetDescriptor = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'set')!
    const define = Object.defineProperty
    let completed = false
    try {
      define(Object, 'freeze', {
        value: () => {
          throw new Error('patched')
        }
      })
      define(Set.prototype, 'add', {
        value: () => {
          throw new Error('patched')
        }
      })
      define(Array.prototype, 'push', {
        value: () => {
          throw new Error('patched')
        }
      })
      define(typedArrayPrototype, 'set', {
        value: () => {
          throw new Error('patched')
        }
      })
      const port = createTestPort()
      const cipher = port.createContext({
        algorithm: 'aes-256-gcm',
        iv: new Uint8Array(12),
        key: new Uint8Array(32),
        kind: 'cipher'
      })
      port.setAAD(cipher, Uint8Array.of(1, 2, 3))
      port.update(cipher, Uint8Array.of(4, 5, 6))
      port.final(cipher)
      completed = true
    } finally {
      define(Object, 'freeze', freezeDescriptor)
      define(Set.prototype, 'add', setAddDescriptor)
      define(Array.prototype, 'push', arrayPushDescriptor)
      define(typedArrayPrototype, 'set', typedSetDescriptor)
    }
    expect(completed).toBe(true)
  })

  it('disposes every context without the mutable Array iterator and redacts failures', () => {
    const iteratorDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator
    )!
    const define = Object.defineProperty
    const base = createTestProvider()
    let adapterDisposals = 0
    let contextDisposals = 0
    let failure: unknown
    const port = createTestPort(
      undefined,
      overrideProvider(base, {
        dispose: () => {
          adapterDisposals += 1
          base.dispose()
        },
        disposeContext: () => {
          contextDisposals += 1
          throw new Error('native secret from context cleanup')
        }
      })
    )
    port.createContext({ algorithm: 'sha1', kind: 'hash' })
    port.createContext({ algorithm: 'sha256', kind: 'hash' })
    try {
      define(Array.prototype, Symbol.iterator, {
        configurable: true,
        value: () => {
          throw new Error('patched Array iterator')
        }
      })
      port.dispose()
    } catch (error) {
      failure = error
    } finally {
      define(Array.prototype, Symbol.iterator, iteratorDescriptor)
    }
    expect(failure).toEqual(expect.objectContaining({
      code: 'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED',
      message: 'The Holonomy Runtime crypto operation failed'
    }))
    expect(String(failure)).not.toContain('native secret')
    expect(contextDisposals).toBe(2)
    expect(adapterDisposals).toBe(1)
    expect(() => port.dispose()).not.toThrow()
  })

  it('rejects forged guest context handles', () => {
    const port = createTestPort()
    expect(() => port.update(Object.freeze({}) as never, Uint8Array.of(1))).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    )
  })
})
