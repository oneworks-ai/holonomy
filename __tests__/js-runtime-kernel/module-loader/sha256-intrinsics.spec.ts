import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'

import { sha256Hex, sha256HexOwnedBytes } from '../../../src/module-loader/sha256.js'

it('keeps Module Loader SHA-256 vectors across block boundaries', () => {
  for (const length of [0, 1, 55, 56, 64, 100, 1024]) {
    const bytes = Uint8Array.from({ length }, (_, index) => index & 0xFF)
    const expected = createHash('sha256').update(bytes).digest('hex')
    expect(sha256Hex(bytes)).toBe(expected)
    expect(sha256HexOwnedBytes(bytes, length)).toBe(expected)
  }
})

it('hashes owned byte slots without reading mutable input properties', () => {
  const bytes = Uint8Array.of(0, 255, 1, 10, 65)
  const expected = createHash('sha256').update(bytes).digest('hex')
  let reads = 0
  const trap = () => {
    reads += 1
    throw new Error('guest property must not run')
  }
  for (const key of ['byteLength', 'buffer', 'length', 'set', 'constructor']) {
    Object.defineProperty(bytes, key, { get: trap })
  }
  Object.defineProperty(bytes, Symbol.iterator, { get: trap })
  Object.defineProperty(bytes, Symbol.species, { get: trap })
  expect(sha256Hex(bytes)).toBe(expected)
  expect(sha256HexOwnedBytes(bytes, 5)).toBe(expected)
  expect(reads).toBe(0)
  expect(() => sha256HexOwnedBytes(bytes, 4)).toThrow()
})
