/* eslint-disable max-lines -- primitive lifecycle and adversarial regressions stay together as one contract suite. */
import { describe, expect, it } from 'vitest'

import type { CryptoPrimitivePort } from '../../../src/crypto/primitive-port.js'
import type { CryptoPrimitiveContextRequest, CryptoPrimitiveProvider } from '../../../src/crypto/types.js'

import { concatBytes, createTestPort, createTestProvider, overrideProvider } from './fixtures.js'

const expectCode = (operation: () => unknown, code: string): void => {
  expect(operation).toThrowError(expect.objectContaining({ code }))
}

const constrainedLimits = {
  maxAadBytes: 16,
  maxCompareBytes: 16,
  maxContextBytes: 16,
  maxContexts: 4,
  maxHmacKeyBytes: 16,
  maxInFlightContextBytes: 32,
  maxRandomBytesPerCall: 16,
  maxUpdateBytesPerCall: 16
} as const

const createBufferedProvider = (): CryptoPrimitiveProvider => {
  const base = createTestProvider()
  const chunks = new WeakMap<object, Uint8Array[]>()
  const kinds = new WeakMap<object, CryptoPrimitiveContextRequest['kind']>()
  return overrideProvider(base, {
    createContext: request => {
      const context = base.createContext(request) as object
      chunks.set(context, [])
      kinds.set(context, request.kind)
      return context
    },
    disposeContext: context => {
      chunks.delete(context as object)
      kinds.delete(context as object)
      base.disposeContext(context)
    },
    final: context => {
      const baseFinal = base.final(context)
      const output = concatBytes(...(chunks.get(context as object) ?? []), baseFinal.output)
      chunks.set(context as object, [])
      return kinds.get(context as object) === 'decipher'
        ? Object.freeze({ authenticated: baseFinal.authenticated, output })
        : Object.freeze({ authTag: baseFinal.authTag, output })
    },
    update: (context, input) => {
      const output = base.update(context, input)
      chunks.get(context as object)!.push(output)
      return new Uint8Array(0)
    }
  })
}

describe('cryptoPrimitivePort state and provider boundary', () => {
  it('accepts provider-buffered AES-GCM update output and validates only terminal totals', () => {
    const port = createTestPort(undefined, createBufferedProvider())
    const key = new Uint8Array(32)
    const iv = new Uint8Array(12)
    const plaintext = Uint8Array.from([1, 2, 3, 4, 5])
    const cipher = port.createContext({ algorithm: 'aes-256-gcm', iv, key, kind: 'cipher' })
    expect(port.update(cipher, plaintext)).toHaveLength(0)
    const encrypted = port.final(cipher)
    expect(encrypted.output).toHaveLength(plaintext.length)
    expect(encrypted.authTag).toHaveLength(16)

    const decipher = port.createContext({ algorithm: 'aes-256-gcm', iv, key, kind: 'decipher' })
    port.setAuthTag(decipher, encrypted.authTag!)
    expect(port.update(decipher, encrypted.output)).toHaveLength(0)
    expect(port.final(decipher).output).toEqual(plaintext)
  })

  it('delegates timingSafeEqual to the provider and requires a strict boolean', () => {
    const base = createTestProvider()
    let calls = 0
    const provider = overrideProvider(base, {
      timingSafeEqual: (left, right) => {
        calls += 1
        return base.timingSafeEqual(left, right)
      }
    })
    const port = createTestPort(undefined, provider)
    expect(port.timingSafeEqual(Uint8Array.of(1), Uint8Array.of(1))).toBe(true)
    expect(calls).toBe(1)

    const invalid = createTestPort(
      undefined,
      overrideProvider(createTestProvider(), {
        timingSafeEqual: () => 1 as unknown as boolean
      })
    )
    expectCode(
      () => invalid.timingSafeEqual(Uint8Array.of(1), Uint8Array.of(1)),
      'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'
    )
  })

  it('keeps contexts usable after recoverable guest argument, state and quota errors', () => {
    const hashPort = createTestPort({
      ...constrainedLimits,
      maxInFlightContextBytes: 64,
      maxUpdateBytesPerCall: 2
    })
    const hash = hashPort.createContext({ algorithm: 'sha256', kind: 'hash' })
    expectCode(
      () => hashPort.update(hash, new Uint16Array([1]) as unknown as Uint8Array),
      'ERR_INVALID_ARG_TYPE'
    )
    expectCode(
      () => hashPort.update(hash, Uint8Array.of(1, 2, 3)),
      'ERR_HOLONOMY_RESOURCE_EXHAUSTED'
    )
    hashPort.update(hash, Uint8Array.of(1, 2))
    expect(hashPort.digest(hash)).toHaveLength(32)

    const cipherPort = createTestPort()
    const cipher = cipherPort.createContext({
      algorithm: 'aes-256-gcm',
      iv: new Uint8Array(12),
      key: new Uint8Array(32),
      kind: 'cipher'
    })
    cipherPort.update(cipher, Uint8Array.of(1))
    expectCode(() => cipherPort.setAAD(cipher, Uint8Array.of(2)), 'ERR_CRYPTO_INVALID_STATE')
    expect(cipherPort.final(cipher).authTag).toHaveLength(16)

    const aadPort = createTestPort({ maxAadBytes: 2 })
    const aadCipher = aadPort.createContext({
      algorithm: 'aes-256-gcm',
      iv: new Uint8Array(12),
      key: new Uint8Array(32),
      kind: 'cipher'
    })
    expectCode(
      () => aadPort.setAAD(aadCipher, Uint8Array.of(1, 2, 3)),
      'ERR_HOLONOMY_RESOURCE_EXHAUSTED'
    )
    aadPort.setAAD(aadCipher, Uint8Array.of(1, 2))
    expect(aadPort.final(aadCipher).authTag).toHaveLength(16)

    expectCode(
      () =>
        createTestPort({ maxHmacKeyBytes: 2 }).createContext({
          algorithm: 'sha256',
          key: Uint8Array.of(1, 2, 3),
          kind: 'hmac'
        }),
      'ERR_HOLONOMY_RESOURCE_EXHAUSTED'
    )
  })

  it('releases terminal, provider-failed and explicitly disposed contexts', () => {
    const port = createTestPort({ ...constrainedLimits, maxContexts: 1 })
    const hash = port.createContext({ algorithm: 'sha1', kind: 'hash' })
    expect(port.digest(hash)).toHaveLength(20)
    expectCode(() => port.digest(hash), 'ERR_CRYPTO_HASH_FINALIZED')
    expect(() => port.createContext({ algorithm: 'sha1', kind: 'hash' })).not.toThrow()

    const base = createTestProvider()
    const throwingPort = createTestPort(
      { ...constrainedLimits, maxContexts: 1 },
      overrideProvider(base, {
        update: () => {
          throw new Error('native secret')
        }
      })
    )
    const failed = throwingPort.createContext({ algorithm: 'sha256', kind: 'hash' })
    expectCode(
      () => throwingPort.update(failed, Uint8Array.of(1)),
      'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'
    )
    expectCode(
      () => throwingPort.update(failed, Uint8Array.of(1)),
      'ERR_HOLONOMY_CRYPTO_DISPOSED'
    )
    expect(() => throwingPort.createContext({ algorithm: 'sha256', kind: 'hash' })).not.toThrow()
  })

  it('poisons the active context on provider reentry even when the provider catches it', () => {
    const base = createTestProvider()
    let port: CryptoPrimitivePort
    const provider = overrideProvider(base, {
      update: (context, input) => {
        try {
          port.randomBytes(1)
        } catch {
          // A malicious provider cannot hide the outer-call poison flag.
        }
        return base.update(context, input)
      }
    })
    port = createTestPort(undefined, provider)
    const handle = port.createContext({ algorithm: 'sha256', kind: 'hash' })
    expectCode(
      () => port.update(handle, Uint8Array.of(1)),
      'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'
    )
    expectCode(() => port.digest(handle), 'ERR_HOLONOMY_CRYPTO_DISPOSED')
  })

  it('rejects async provider returns and releases the affected context', () => {
    const base = createTestProvider()
    const port = createTestPort(
      undefined,
      overrideProvider(base, {
        update: () => Promise.resolve(new Uint8Array(0)) as unknown as Uint8Array
      })
    )
    const handle = port.createContext({ algorithm: 'sha256', kind: 'hash' })
    expectCode(
      () => port.update(handle, Uint8Array.of(1)),
      'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'
    )
    expectCode(() => port.digest(handle), 'ERR_HOLONOMY_CRYPTO_DISPOSED')
  })

  it('absorbs rejected async provider returns without raw details or unhandled rejections', async () => {
    const base = createTestProvider()
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', listener)
    try {
      const port = createTestPort(
        undefined,
        overrideProvider(base, {
          update: () => Promise.reject(new Error('native key/plaintext detail')) as unknown as Uint8Array
        })
      )
      const handle = port.createContext({ algorithm: 'sha256', kind: 'hash' })
      expectCode(
        () => port.update(handle, Uint8Array.of(1)),
        'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'
      )
      await Promise.resolve()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  it('fails closed on hostile async returns while the provider owns unreplaceable rejections', async () => {
    const base = createTestProvider()
    let constructorGetterCalls = 0
    let providerResult: unknown
    let thenGetterCalls = 0
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => {
      unhandled.push(reason)
    }
    const port = createTestPort(
      undefined,
      overrideProvider(base, {
        update: () => providerResult as Uint8Array
      })
    )
    process.on('unhandledRejection', listener)
    try {
      const constructorPoisoned = Promise.reject(new Error('raw constructor rejection'))
      Object.defineProperty(constructorPoisoned, 'constructor', {
        configurable: true,
        get: () => {
          throw new Error('constructor lookup detail')
        }
      })
      providerResult = constructorPoisoned
      const first = port.createContext({ algorithm: 'sha256', kind: 'hash' })
      expectCode(
        () => port.update(first, Uint8Array.of(1)),
        'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'
      )

      const speciesPoisoned = Promise.reject(new Error('raw species rejection'))
      const constructor = {}
      Object.defineProperty(constructor, Symbol.species, {
        get: () => {
          throw new Error('species lookup detail')
        }
      })
      Object.defineProperty(speciesPoisoned, 'constructor', {
        configurable: true,
        value: constructor
      })
      providerResult = speciesPoisoned
      const second = port.createContext({ algorithm: 'sha256', kind: 'hash' })
      expectCode(
        () => port.update(second, Uint8Array.of(2)),
        'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'
      )

      const thenable = {}
      Object.defineProperty(thenable, 'then', {
        get: () => {
          thenGetterCalls += 1
          throw new Error('then getter detail')
        }
      })
      providerResult = thenable
      const third = port.createContext({ algorithm: 'sha256', kind: 'hash' })
      expectCode(
        () => port.update(third, Uint8Array.of(3)),
        'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'
      )

      const providerObserved = Promise.reject(new Error('provider-owned raw rejection'))
      const providerObservation = providerObserved.catch(() => undefined)
      Object.defineProperty(providerObserved, 'constructor', {
        configurable: false,
        get: () => {
          constructorGetterCalls += 1
          throw new Error('unreplaceable constructor detail')
        }
      })
      providerResult = providerObserved
      const fourth = port.createContext({ algorithm: 'sha256', kind: 'hash' })
      expectCode(
        () => port.update(fourth, Uint8Array.of(4)),
        'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'
      )

      await providerObservation
      await Promise.resolve()
      await Promise.resolve()
      expect(unhandled).toEqual([])
      expect(constructorGetterCalls).toBe(1)
      expect(thenGetterCalls).toBe(0)
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  it('does not create a context when snapshot inspection disposes the port', () => {
    const base = createTestProvider()
    let creates = 0
    const port = createTestPort(
      undefined,
      overrideProvider(base, {
        createContext: request => {
          creates += 1
          return base.createContext(request)
        }
      })
    )
    const request = new Proxy({ algorithm: 'sha256', kind: 'hash' }, {
      getPrototypeOf: () => {
        port.dispose()
        return Object.prototype
      }
    })
    expectCode(
      () => port.createContext(request as never),
      'ERR_HOLONOMY_CRYPTO_DISPOSED'
    )
    expect(creates).toBe(0)
  })

  it('disposes invalid, thenable and colliding createContext outputs exactly once', () => {
    const base = createTestProvider()
    let invalidDisposals = 0
    const invalid = createTestPort(
      undefined,
      overrideProvider(base, {
        createContext: () => 7,
        disposeContext: context => {
          expect(context).toBe(7)
          invalidDisposals += 1
        }
      })
    )
    expectCode(
      () => invalid.createContext({ algorithm: 'sha1', kind: 'hash' }),
      'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'
    )
    expect(invalidDisposals).toBe(1)

    let thenableDisposals = 0
    const thenableContext = Object.freeze({ then: () => undefined })
    const thenable = createTestPort(
      undefined,
      overrideProvider(createTestProvider(), {
        createContext: () => thenableContext,
        disposeContext: context => {
          expect(context).toBe(thenableContext)
          thenableDisposals += 1
        }
      })
    )
    expectCode(
      () => thenable.createContext({ algorithm: 'sha1', kind: 'hash' }),
      'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'
    )
    expect(thenableDisposals).toBe(1)

    const shared = Object.freeze({})
    let collisionDisposals = 0
    const collision = createTestPort(
      undefined,
      overrideProvider(createTestProvider(), {
        createContext: () => shared,
        disposeContext: () => {
          collisionDisposals += 1
        }
      })
    )
    const first = collision.createContext({ algorithm: 'sha1', kind: 'hash' })
    expectCode(
      () => collision.createContext({ algorithm: 'sha1', kind: 'hash' }),
      'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'
    )
    expect(collisionDisposals).toBe(1)
    expectCode(() => collision.digest(first), 'ERR_HOLONOMY_CRYPTO_DISPOSED')
  })

  it('validates exact digest lengths for SHA-1, SHA-256 and HMAC-SHA256', () => {
    for (
      const request of [
        { algorithm: 'sha1', kind: 'hash' },
        { algorithm: 'sha256', kind: 'hash' },
        { algorithm: 'sha256', key: Uint8Array.of(1), kind: 'hmac' }
      ] as const
    ) {
      const base = createTestProvider()
      const expected = request.algorithm === 'sha1' ? 32 : 20
      const port = createTestPort(
        undefined,
        overrideProvider(base, {
          digest: () => new Uint8Array(expected)
        })
      )
      const handle = port.createContext(request)
      expectCode(() => port.digest(handle), 'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED')
    }
  })

  it('maps authentication false before examining a malformed final output length', () => {
    const base = createTestProvider()
    const port = createTestPort(
      undefined,
      overrideProvider(base, {
        final: context => {
          base.final(context)
          return Object.freeze({ authenticated: false, output: new Uint8Array(7) })
        }
      })
    )
    const handle = port.createContext({
      algorithm: 'aes-256-gcm',
      iv: new Uint8Array(12),
      key: new Uint8Array(32),
      kind: 'decipher'
    })
    port.setAuthTag(handle, new Uint8Array(16))
    port.update(handle, Uint8Array.of(1))
    expectCode(() => port.final(handle), 'ERR_CRYPTO_INVALID_AUTH_TAG')
  })

  it('enforces constructor ceilings, compare quota and aggregate retained bytes', () => {
    expectCode(
      () => createTestPort({ maxContexts: 65 }),
      'ERR_OUT_OF_RANGE'
    )
    const port = createTestPort(constrainedLimits)
    const first = port.createContext({
      algorithm: 'sha256',
      key: new Uint8Array(16),
      kind: 'hmac'
    })
    port.createContext({ algorithm: 'sha256', key: new Uint8Array(16), kind: 'hmac' })
    expectCode(
      () => port.createContext({ algorithm: 'sha256', key: Uint8Array.of(1), kind: 'hmac' }),
      'ERR_HOLONOMY_RESOURCE_EXHAUSTED'
    )
    port.disposeContext(first)
    expect(() =>
      port.createContext({
        algorithm: 'sha256',
        key: Uint8Array.of(1),
        kind: 'hmac'
      })
    ).not.toThrow()
    expectCode(
      () => port.timingSafeEqual(new Uint8Array(17), new Uint8Array(17)),
      'ERR_HOLONOMY_RESOURCE_EXHAUSTED'
    )

    const outputBounded = createTestPort({
      ...constrainedLimits,
      maxInFlightContextBytes: 48
    })
    const outputHandle = outputBounded.createContext({
      algorithm: 'sha256',
      key: new Uint8Array(16),
      kind: 'hmac'
    })
    outputBounded.update(outputHandle, new Uint8Array(16))
    expectCode(
      () => outputBounded.digest(outputHandle),
      'ERR_HOLONOMY_RESOURCE_EXHAUSTED'
    )
    expectCode(
      () => outputBounded.update(outputHandle, Uint8Array.of(1)),
      'ERR_HOLONOMY_CRYPTO_DISPOSED'
    )
  })

  it('calls adapter-wide dispose exactly once as a close backstop', () => {
    const base = createTestProvider()
    let disposals = 0
    const port = createTestPort(
      undefined,
      overrideProvider(base, {
        dispose: () => {
          disposals += 1
          base.dispose()
        }
      })
    )
    port.createContext({ algorithm: 'sha1', kind: 'hash' })
    port.dispose()
    port.dispose()
    expect(disposals).toBe(1)
    expectCode(() => port.randomBytes(1), 'ERR_HOLONOMY_CRYPTO_DISPOSED')
  })
})
