import { Buffer as NodeBuffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { Buffer } from '../../src/node-compat/buffer.js'

describe('node:buffer compatibility', () => {
  it('matches Node for valid promised encodings', () => {
    const samples = ['plain ascii', '你好, mobile 🌍', '\u0000\u0001\u007F', 'unpaired \uD800']
    for (const sample of samples) {
      const runtime = Buffer.from(sample, 'utf8')
      const node = NodeBuffer.from(sample, 'utf8')
      expect([...runtime]).toEqual([...node])
      expect(runtime.toString('utf8')).toBe(node.toString('utf8'))
      expect(Buffer.byteLength(sample, 'utf8')).toBe(NodeBuffer.byteLength(sample, 'utf8'))
    }

    const bytes = [0, 1, 2, 127, 128, 254, 255]
    for (const encoding of ['base64', 'base64url', 'hex'] as const) {
      const encoded = NodeBuffer.from(bytes).toString(encoding)
      const runtime = Buffer.from(encoded, encoding)
      expect([...runtime]).toEqual(bytes)
      expect(runtime.toString(encoding)).toBe(encoded)
      expect(Buffer.byteLength(encoded, encoding)).toBe(bytes.length)
    }
  })

  it('matches Node ArrayBuffer offset and length views', () => {
    const cases: Array<[number | undefined, number | undefined]> = [
      [undefined, undefined],
      [2, undefined],
      [2, 3],
      [1.5, 3.8],
      [Number.NaN, 2],
      [2, -1]
    ]
    for (const [offset, length] of cases) {
      const arrayBuffer = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]).buffer
      const runtime = Buffer.from(arrayBuffer, offset, length)
      const node = NodeBuffer.from(arrayBuffer, offset, length)
      expect([...runtime], `${String(offset)}:${String(length)}`).toEqual([...node])
      expect(runtime.byteOffset).toBe(node.byteOffset)
      if (runtime.length > 0) {
        runtime[0] = 99
        expect(new Uint8Array(arrayBuffer)[runtime.byteOffset]).toBe(99)
      }
    }
    expect(() => Buffer.from(new ArrayBuffer(2), 3)).toThrowError(
      expect.objectContaining({ code: 'ERR_MOBILE_RUNTIME_OUT_OF_BOUNDS' })
    )
    expect(() => Buffer.from(new ArrayBuffer(2), 1, 2)).toThrowError(
      expect.objectContaining({ code: 'ERR_MOBILE_RUNTIME_OUT_OF_BOUNDS' })
    )
  })

  it('matches Node raw fractional ArrayBuffer boundary decisions', () => {
    const offsets = [
      0.5,
      1.5,
      7.5,
      8,
      -0.5,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY
    ]
    const lengths = [
      undefined,
      8,
      7,
      1,
      0.5,
      0,
      -0.5,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY
    ]
    for (const offset of offsets) {
      for (const length of lengths) {
        const runtimeBuffer = new ArrayBuffer(8)
        const nodeBuffer = new ArrayBuffer(8)
        const capture = (create: () => Uint8Array) => {
          try {
            const result = create()
            return {
              byteOffset: result.byteOffset,
              bytes: [...result],
              ok: true as const
            }
          } catch {
            return { ok: false as const }
          }
        }
        const runtime = capture(() => Buffer.from(runtimeBuffer, offset, length))
        const node = capture(() => NodeBuffer.from(nodeBuffer, offset, length))
        expect(runtime, `${String(offset)}:${String(length)}`).toEqual(node)
      }
    }
  })

  it('matches Node malformed UTF-8 replacement', () => {
    const malformed = [
      [0xE2, 0x82],
      [0xF0, 0x9F, 0x92],
      [0xE2, 0x28, 0xA1],
      [0xED, 0xA0, 0x80],
      [0xC0, 0xAF],
      [0xF4, 0x90, 0x80, 0x80],
      [0x61, 0xE2, 0x82, 0x62]
    ]
    for (const bytes of malformed) {
      expect(Buffer.from(bytes).toString()).toBe(NodeBuffer.from(bytes).toString())
    }
  })

  it('matches Node forgiving base64 and truncating hex decode and byteLength', () => {
    const base64Cases = [
      '',
      'Zg==',
      'Zg=',
      'Zg',
      'Z',
      'Zm8===',
      'Zm$8',
      'Zm 8',
      '====',
      '-w',
      '_w',
      'ab=c',
      'YWJjZA===',
      'YWJjZA?'
    ]
    for (const encoding of ['base64', 'base64url'] as const) {
      for (const value of base64Cases) {
        expect([...Buffer.from(value, encoding)], `${encoding}:${value}`).toEqual([
          ...NodeBuffer.from(value, encoding)
        ])
        expect(Buffer.byteLength(value, encoding)).toBe(
          NodeBuffer.byteLength(value, encoding)
        )
      }
    }
    for (const value of ['', '00', '0', '0g', '0a0', '0a0b', '0a xx', 'gg', 'abzzcd']) {
      expect([...Buffer.from(value, 'hex')], value).toEqual([
        ...NodeBuffer.from(value, 'hex')
      ])
      expect(Buffer.byteLength(value, 'hex')).toBe(NodeBuffer.byteLength(value, 'hex'))
    }
  })

  it('matches Node numeric toString range normalization', () => {
    const runtime = Buffer.from('abcdef')
    const node = NodeBuffer.from('abcdef')
    const ranges = [
      [undefined, undefined],
      [Number.NaN, undefined],
      [Number.NEGATIVE_INFINITY, 3],
      [Number.POSITIVE_INFINITY, undefined],
      [-3, 2.9],
      [-0.5, 2.9],
      [0.9, 3.9],
      [2.9, Number.POSITIVE_INFINITY],
      [0, Number.NEGATIVE_INFINITY]
    ] as const
    for (const [start, end] of ranges) {
      expect(runtime.toString('utf8', start, end)).toBe(
        node.toString('utf8', start, end)
      )
    }
  })

  it('provides Buffer identity, concat and safe allocation', () => {
    const first = Buffer.from('ab')
    const second = Buffer.from([99, 100])
    expect(Buffer.isBuffer(first)).toBe(true)
    expect(Buffer.isBuffer(new Uint8Array())).toBe(false)
    expect(Buffer.concat([first, second]).toString()).toBe('abcd')
    expect([...Buffer.concat([first], 4)]).toEqual([97, 98, 0, 0])
    expect([...Buffer.concat([first, second], 3)]).toEqual([97, 98, 99])
    expect([...Buffer.alloc(4)]).toEqual([0, 0, 0, 0])
    expect([...Buffer.allocUnsafe(4)]).toEqual([0, 0, 0, 0])
  })

  it('uses view semantics for subarray and slice', () => {
    const value = Buffer.from('abcd')
    const subarray = value.subarray(1, 3)
    const slice = value.slice(2)
    subarray[0] = 90
    slice[0] = 89
    expect(Buffer.isBuffer(subarray)).toBe(true)
    expect(Buffer.isBuffer(slice)).toBe(true)
    expect(value.toString()).toBe('aZYd')
    expect(value.equals(Buffer.from('aZYd'))).toBe(true)
  })

  it('reports stable invalid sizes and encodings', () => {
    expect(() => Buffer.alloc(-1)).toThrowError(
      expect.objectContaining({ code: 'ERR_MOBILE_RUNTIME_INVALID_ARGUMENT' })
    )
    expect(() => Buffer.from('abc', 'latin1')).toThrowError(
      expect.objectContaining({ code: 'ERR_MOBILE_RUNTIME_INVALID_ENCODING' })
    )
    expect([...Buffer.from('a', 'base64')]).toEqual([])
  })
})
