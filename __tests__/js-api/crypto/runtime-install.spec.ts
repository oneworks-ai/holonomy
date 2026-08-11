import { describe, expect, it } from 'vitest'

import { CRYPTO_CAPABILITY_MATRIX } from '../../../src/crypto/capabilities.js'
import { installCryptoRuntime } from '../../../src/crypto/runtime-install.js'
import * as mobileRuntime from '../../../src/index.js'

import { createTestProvider, overrideProvider } from './fixtures.js'

describe('guarded crypto runtime installation', () => {
  it('creates namespaces and advertisements only after provider self-test succeeds', () => {
    const installed = installCryptoRuntime({ provider: createTestProvider() })
    const binding = installed.createSyntheticModuleBinding()
    expect(binding.descriptor.exportNames).toEqual(Object.keys(binding.namespace))
    expect(binding.descriptor.exportNames).toContain('createHash')
    expect(binding.descriptor.exportNames).toContain('default')

    expect(installed.capabilityDescriptors).toEqual([
      expect.objectContaining({ id: 'host.crypto', provider: 'supported', version: '1.0.0' }),
      expect.objectContaining({
        id: 'node.crypto',
        mappedTo: 'host.crypto',
        provider: 'host-mapped',
        version: '1.0.0'
      }),
      expect.objectContaining({
        id: 'web.crypto',
        mappedTo: 'host.crypto',
        provider: 'host-mapped',
        version: '1.0.0'
      })
    ])
    expect(installed.capabilityDescriptors[0]!.features).toContain(
      'host.crypto.timing-safe-equal'
    )
    expect(installed.capabilityDescriptors[1]!.features).toContain(
      'node.crypto.random-bytes-sync'
    )
    expect(installed.capabilityDescriptors[0]!.constraints).toMatchObject({
      'host.crypto.provider.async-rejection-observer-owner': 'provider',
      'host.crypto.provider.strict-sync-return': true
    })
    installed.dispose()
    expect(() => installed.createSyntheticModuleBinding()).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_CRYPTO_DISPOSED' })
    )
  })

  it('fails closed and closes the adapter when self-test fails', () => {
    const base = createTestProvider()
    let adapterCloses = 0
    const provider = overrideProvider(base, {
      digest: () => new Uint8Array(1),
      dispose: () => {
        adapterCloses += 1
        base.dispose()
      }
    })
    expect(() => installCryptoRuntime({ provider })).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED',
      message: 'The Holonomy Runtime crypto operation failed'
    }))
    expect(adapterCloses).toBe(1)
  })

  it('zeroes provider-admission key copies when the self-test fails', () => {
    const base = createTestProvider()
    let retainedHmacKey: Uint8Array | undefined
    const provider = overrideProvider(base, {
      createContext: request => {
        if (request.kind === 'hmac') retainedHmacKey = request.key
        return base.createContext(request)
      },
      digest: context => retainedHmacKey === undefined ? base.digest(context) : new Uint8Array(1)
    })
    expect(() => installCryptoRuntime({ provider })).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'
    }))
    expect(retainedHmacKey).toEqual(new Uint8Array(20))
  })

  it('installs the bounded Web crypto facade without subtle', () => {
    const installed = installCryptoRuntime({ provider: createTestProvider() })
    const target = {}
    const webCrypto = installed.installWebCrypto(target)
    const array = new Uint16Array(8)
    expect(webCrypto.getRandomValues(array)).toBe(array)
    expect([...array]).not.toEqual(Array.from({ length: 8 }).fill(0))
    expect((target as { crypto?: unknown }).crypto).toBe(webCrypto)
    expect('subtle' in webCrypto).toBe(false)
    expect(() => webCrypto.getRandomValues(new Float32Array(2))).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    )
    expect(() => webCrypto.getRandomValues(new Uint8Array(65_537))).toThrowError(
      expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' })
    )
  })

  it('keeps deterministic reference crypto out of production exports', () => {
    expect('createDeterministicCryptoPrimitiveProvider' in mobileRuntime).toBe(false)
    expect('createCryptoSyntheticModule' in mobileRuntime).toBe(false)
    expect('createInstalledCryptoCapabilityDescriptors' in mobileRuntime).toBe(false)
    expect('installCryptoRuntime' in mobileRuntime).toBe(true)
  })

  it('exposes a precise static matrix without claiming Android provider wiring', () => {
    expect(CRYPTO_CAPABILITY_MATRIX.capabilityVersion).toBe('1.0.0')
    expect(CRYPTO_CAPABILITY_MATRIX.hostCrypto).not.toHaveProperty('provider')
    expect(CRYPTO_CAPABILITY_MATRIX.nodeCrypto.mappedTo).toBe('host.crypto')
    expect(CRYPTO_CAPABILITY_MATRIX.webCrypto.mappedTo).toBe('host.crypto')
    expect(CRYPTO_CAPABILITY_MATRIX.webCrypto.later).toContain('web.crypto.subtle')
    expect(
      CRYPTO_CAPABILITY_MATRIX.nodeCrypto.constraints[
        'node.crypto.aes-256-gcm.update-chunk-timing'
      ]
    ).toBe('provider-buffered')
    expect(
      CRYPTO_CAPABILITY_MATRIX.hostCrypto.constraints[
        'host.crypto.provider.async-rejection-observer-owner'
      ]
    ).toBe('provider')
    expect(
      CRYPTO_CAPABILITY_MATRIX.hostCrypto.constraints[
        'host.crypto.provider.strict-sync-return'
      ]
    ).toBe(true)
  })

  it('runs in a bare-V8-style realm without ambient Buffer, TextEncoder or crypto', () => {
    const names = ['Buffer', 'TextEncoder', 'crypto'] as const
    const descriptors = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
    let digest = ''
    try {
      for (const name of names) {
        Object.defineProperty(globalThis, name, {
          configurable: true,
          value: undefined,
          writable: true
        })
      }
      const installed = installCryptoRuntime({ provider: createTestProvider() })
      digest = installed.createSyntheticModuleBinding().namespace
        .createHash('sha256')
        .update('abc')
        .digest('hex')
    } finally {
      for (let index = 0; index < names.length; index += 1) {
        const descriptor = descriptors[index]
        if (descriptor === undefined) {
          Reflect.deleteProperty(globalThis, names[index]!)
        } else {
          Object.defineProperty(globalThis, names[index]!, descriptor)
        }
      }
    }
    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
