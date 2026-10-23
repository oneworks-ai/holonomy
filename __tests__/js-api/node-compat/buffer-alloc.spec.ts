import { Buffer as NodeBuffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { Buffer } from '../../../src/node-compat/buffer.js'

const alloc = Buffer.alloc as (size: unknown, fill?: unknown, encoding?: unknown) => Uint8Array
const nodeAlloc = NodeBuffer.alloc as typeof alloc
const invalid = { code: 'ERR_HOLONOMY_INVALID_ARGUMENT' }

describe('buffer.alloc bounded Node fill compatibility', () => {
  it('fills every byte of the RFC HMAC key instead of silently ignoring fill', () => {
    expect([...Buffer.alloc(20, 0x0B)]).toEqual([...NodeBuffer.alloc(20, 0x0B)])
    expect([...Buffer.alloc(20, 0x0B)]).toEqual(Array.from({ length: 20 }, () => 0x0B))
  })

  it('matches numeric truncation, non-finite fill and the RFC HMAC key', () => {
    for (const size of [0, 0.5, 1, 1.9, 20]) {
      for (const fill of [undefined, 0x0B, -1.9, 256.8, Number.NaN, Infinity, -Infinity]) {
        expect([...alloc(size, fill)]).toEqual([...nodeAlloc(size, fill)])
      }
    }
    expect([...Buffer.allocUnsafe(3)]).toEqual([0, 0, 0])
  })

  it('repeats and truncates strings using the existing encoding subset', () => {
    const cases = [
      ['ab', undefined],
      ['你好🌍', 'utf8'],
      ['é', 'UTF-8'],
      ['', 'utf8'],
      ['a1b2zz', 'hex'],
      ['YWJj', 'base64'],
      ['-w', 'base64url'],
      ['a', ''],
      ['a', null]
    ] as const
    for (const size of [0, 0.5, 1, 2, 5, 17]) {
      for (const [fill, encoding] of cases) {
        expect([...alloc(size, fill, encoding)], `${size}:${fill}:${encoding}`).toEqual([
          ...nodeAlloc(size, fill, encoding)
        ])
      }
    }
  })

  it('repeats byte views without invoking subclass hooks or aliasing input', () => {
    const bytes = Uint8Array.from([9, 1, 2, 3, 9]).subarray(1, 4)
    for (const fill of [bytes, Buffer.from([1, 2, 3]), NodeBuffer.from([1, 2, 3])]) {
      for (const size of [0, 0.5, 1, 2, 5, 17]) {
        expect([...alloc(size, fill, 'ignored')]).toEqual([...nodeAlloc(size, fill, 'ignored')])
      }
    }
    class Hostile extends Uint8Array {
      override get length(): number {
        throw new Error('length')
      }
      override subarray(): never {
        throw new Error('subarray')
      }
      override [Symbol.iterator](): never {
        throw new Error('iterator')
      }
      static get [Symbol.species](): never {
        throw new Error('species')
      }
    }
    const fill = new Hostile([4, 5])
    const output = alloc(5, fill)
    fill[0] = 99
    expect([...output]).toEqual([4, 5, 4, 5, 4])
  })

  it('validates size first and skips fill/encoding only at raw size zero', () => {
    const hostile = {
      get valueOf(): never {
        throw new Error('coercion')
      }
    }
    for (const size of [-1, -0.5, Number.NaN, Infinity, -Infinity, '2', null, undefined, 1n]) {
      expect(() => alloc(size, hostile, 'bogus')).toThrowError(expect.objectContaining(invalid))
      expect(() => nodeAlloc(size, hostile, 'bogus')).toThrow()
    }
    expect([...alloc(0, hostile, 'bogus')]).toEqual([...nodeAlloc(0, hostile, 'bogus')])
    expect(() => alloc(0.5, 'a', 'bogus')).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_INVALID_ENCODING' })
    )
    expect(() => nodeAlloc(0.5, 'a', 'bogus')).toThrow()
  })

  it('rejects invalid encodings and empty decoded/byte patterns with stable codes', () => {
    for (const encoding of ['bogus', 'latin1']) {
      expect(() => alloc(2, '', encoding)).toThrowError(
        expect.objectContaining({ code: 'ERR_HOLONOMY_INVALID_ENCODING' })
      )
    }
    for (const encoding of [1, false, {}, Symbol('encoding')]) {
      expect(() => alloc(2, 'a', encoding)).toThrowError(expect.objectContaining(invalid))
      expect(() => nodeAlloc(2, 'a', encoding)).toThrow()
    }
    for (
      const [fill, encoding] of [[new Uint8Array(), undefined], ['gg', 'hex'], ['a', 'hex'], ['=', 'base64']] as const
    ) {
      expect(() => alloc(2, fill, encoding)).toThrowError(expect.objectContaining(invalid))
      expect(() => nodeAlloc(2, fill, encoding)).toThrow()
      expect([...alloc(0.5, fill, encoding)]).toEqual([...nodeAlloc(0.5, fill, encoding)])
    }
    expect([...alloc(3, 7, {})]).toEqual([...nodeAlloc(3, 7, {})])
  })

  it('explicitly rejects unsupported coercing fill types and fake byte views', () => {
    for (
      const fill of [null, true, {}, [], 1n, Symbol('fill'), new Uint16Array([1]), Object.create(Uint8Array.prototype)]
    ) {
      expect(() => alloc(2, fill)).toThrowError(expect.objectContaining(invalid))
    }
  })
})
