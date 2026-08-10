import { describe, expect, it } from 'vitest'

import type { CryptoPrimitivePort } from '../../src/crypto/primitive-port.js'
import { runProviderSelfTest } from '../../src/crypto/runtime-self-test.js'
import type { CryptoPrimitiveContextRequest, CryptoPrimitiveFinalResult } from '../../src/crypto/types.js'

import { createTestPort } from './fixtures.js'

describe('crypto provider self-test cleanup', () => {
  it('zeroes every admitted temporary when a middle-stage comparison fails', () => {
    const real = createTestPort()
    const observed = new Set<Uint8Array>()
    let comparisons = 0
    const track = (value: Uint8Array | undefined): void => {
      if (value !== undefined) observed.add(value)
    }
    const port = {
      createContext: (request: CryptoPrimitiveContextRequest) => {
        if (request.kind !== 'hash') track(request.key)
        if (request.kind === 'cipher' || request.kind === 'decipher') track(request.iv)
        return real.createContext(request)
      },
      digest: (handle: never) => {
        const output = real.digest(handle)
        track(output)
        return output
      },
      final: (handle: never): CryptoPrimitiveFinalResult => {
        const result = real.final(handle)
        track(result.output)
        track(result.authTag)
        return result
      },
      randomBytes: (size: number) => {
        const output = real.randomBytes(size)
        track(output)
        return output
      },
      setAAD: (handle: never, value: Uint8Array) => {
        track(value)
        real.setAAD(handle, value)
      },
      setAuthTag: (handle: never, value: Uint8Array) => {
        track(value)
        real.setAuthTag(handle, value)
      },
      timingSafeEqual: (left: Uint8Array, right: Uint8Array) => {
        track(left)
        track(right)
        comparisons += 1
        if (comparisons === 4) throw new Error('middle-stage native comparison detail')
        return real.timingSafeEqual(left, right)
      },
      update: (handle: never, value: Uint8Array) => {
        track(value)
        const output = real.update(handle, value)
        track(output)
        return output
      }
    } as unknown as CryptoPrimitivePort

    expect(() => runProviderSelfTest(port)).toThrowError('middle-stage native comparison detail')
    const values = Array.from(observed)
    expect(values.length).toBeGreaterThan(10)
    for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
      const value = values[valueIndex]!
      for (let byteIndex = 0; byteIndex < value.length; byteIndex += 1) {
        expect(value[byteIndex]).toBe(0)
      }
    }
    real.dispose()
  })
})
