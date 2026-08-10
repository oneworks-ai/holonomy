import { createWebNetworkError } from './errors.js'

export const encodeUtf8 = (value: string): Uint8Array => {
  const bytes: number[] = []
  for (const character of value) {
    const point = character.codePointAt(0)!
    if (point <= 0x7F) bytes.push(point)
    else if (point <= 0x7FF) {
      bytes.push(0xC0 | (point >> 6), 0x80 | (point & 0x3F))
    } else if (point <= 0xFFFF) {
      bytes.push(
        0xE0 | (point >> 12),
        0x80 | ((point >> 6) & 0x3F),
        0x80 | (point & 0x3F)
      )
    } else {
      bytes.push(
        0xF0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3F),
        0x80 | ((point >> 6) & 0x3F),
        0x80 | (point & 0x3F)
      )
    }
  }
  return new Uint8Array(bytes)
}

export const decodeUtf8 = (bytes: Uint8Array): string => {
  let output = ''
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++]
    let point: number
    let remaining: number
    if (first <= 0x7F) {
      point = first
      remaining = 0
    } else if (first >= 0xC2 && first <= 0xDF) {
      point = first & 0x1F
      remaining = 1
    } else if (first >= 0xE0 && first <= 0xEF) {
      point = first & 0x0F
      remaining = 2
    } else if (first >= 0xF0 && first <= 0xF4) {
      point = first & 0x07
      remaining = 3
    } else throw createWebNetworkError('network.protocol_error')

    if (index + remaining > bytes.length) {
      throw createWebNetworkError('network.protocol_error')
    }
    for (let offset = 0; offset < remaining; offset += 1) {
      const continuation = bytes[index++]
      if ((continuation & 0xC0) !== 0x80) {
        throw createWebNetworkError('network.protocol_error')
      }
      point = (point << 6) | (continuation & 0x3F)
    }
    if (
      (remaining === 2 && point < 0x800) ||
      (remaining === 3 && point < 0x10000) ||
      point > 0x10FFFF ||
      (point >= 0xD800 && point <= 0xDFFF)
    ) throw createWebNetworkError('network.protocol_error')
    output += String.fromCodePoint(point)
  }
  return output
}
