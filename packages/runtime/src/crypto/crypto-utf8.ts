import { stringCodeUnitAt } from './intrinsics.js'

interface CodePointStep {
  readonly code: number
  readonly nextIndex: number
}

const nextCodePoint = (value: string, index: number): CodePointStep => {
  let code = stringCodeUnitAt(value, index)
  if (code >= 0xD800 && code <= 0xDBFF) {
    const next = stringCodeUnitAt(value, index + 1)
    if (next >= 0xDC00 && next <= 0xDFFF) {
      code = 0x10000 + ((code - 0xD800) << 10) + next - 0xDC00
      return { code, nextIndex: index + 2 }
    }
    return { code: 0xFFFD, nextIndex: index + 1 }
  }
  if (code >= 0xDC00 && code <= 0xDFFF) return { code: 0xFFFD, nextIndex: index + 1 }
  return { code, nextIndex: index + 1 }
}

export const cryptoUtf8Length = (value: string): number => {
  let length = 0
  let index = 0
  while (index < value.length) {
    const step = nextCodePoint(value, index)
    const code = step.code
    index = step.nextIndex
    length += code <= 0x7F ? 1 : code <= 0x7FF ? 2 : code <= 0xFFFF ? 3 : 4
  }
  return length
}

export const encodeCryptoUtf8 = (value: string): Uint8Array => {
  const output = new Uint8Array(cryptoUtf8Length(value))
  let offset = 0
  let index = 0
  while (index < value.length) {
    const step = nextCodePoint(value, index)
    const code = step.code
    index = step.nextIndex
    if (code <= 0x7F) {
      output[offset] = code
      offset += 1
    } else if (code <= 0x7FF) {
      output[offset] = 0xC0 | (code >>> 6)
      output[offset + 1] = 0x80 | (code & 0x3F)
      offset += 2
    } else if (code <= 0xFFFF) {
      output[offset] = 0xE0 | (code >>> 12)
      output[offset + 1] = 0x80 | ((code >>> 6) & 0x3F)
      output[offset + 2] = 0x80 | (code & 0x3F)
      offset += 3
    } else {
      output[offset] = 0xF0 | (code >>> 18)
      output[offset + 1] = 0x80 | ((code >>> 12) & 0x3F)
      output[offset + 2] = 0x80 | ((code >>> 6) & 0x3F)
      output[offset + 3] = 0x80 | (code & 0x3F)
      offset += 4
    }
  }
  return output
}
