import { createFsError } from './errors.js'

import type { FsEncoding, FsOperationName } from './types.js'

const normalizeEncoding = (
  encoding: FsEncoding | null | undefined,
  syscall: FsOperationName
) => {
  if (encoding == null) return null
  if (encoding !== 'utf8' && encoding !== 'utf-8') {
    throw createFsError('EINVAL', syscall)
  }
  return 'utf8' as const
}

/** Keep the shim usable in a bare V8 embedder without host codec APIs. */
const encodeUtf8 = (value: string) => {
  const bytes: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index)
    if (codePoint >= 0xD800 && codePoint <= 0xDBFF) {
      const low = value.charCodeAt(index + 1)
      if (low >= 0xDC00 && low <= 0xDFFF) {
        codePoint = 0x10000 + ((codePoint - 0xD800) << 10) + low - 0xDC00
        index += 1
      } else {
        codePoint = 0xFFFD
      }
    } else if (codePoint >= 0xDC00 && codePoint <= 0xDFFF) {
      codePoint = 0xFFFD
    }

    if (codePoint <= 0x7F) bytes.push(codePoint)
    else if (codePoint <= 0x7FF) {
      bytes.push(0xC0 | (codePoint >> 6), 0x80 | (codePoint & 0x3F))
    } else if (codePoint <= 0xFFFF) {
      bytes.push(
        0xE0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3F),
        0x80 | (codePoint & 0x3F)
      )
    } else {
      bytes.push(
        0xF0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3F),
        0x80 | ((codePoint >> 6) & 0x3F),
        0x80 | (codePoint & 0x3F)
      )
    }
  }
  return new Uint8Array(bytes)
}

const decodeUtf8 = (bytes: Uint8Array) => {
  let output = ''
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const first = bytes[index]!
    let codePoint = 0xFFFD
    let width = 0
    if (first <= 0x7F) {
      codePoint = first
    } else if (first >= 0xC2 && first <= 0xDF) {
      width = 2
    } else if (first >= 0xE0 && first <= 0xEF) {
      width = 3
    } else if (first >= 0xF0 && first <= 0xF4) {
      width = 4
    }
    if (width > 0) {
      let continuations = 0
      for (let offset = 1; offset < width; offset += 1) {
        const value = bytes[index + offset]
        const valid = value != null &&
          (value & 0xC0) === 0x80 &&
          !(offset === 1 && first === 0xE0 && value < 0xA0) &&
          !(offset === 1 && first === 0xED && value >= 0xA0) &&
          !(offset === 1 && first === 0xF0 && value < 0x90) &&
          !(offset === 1 && first === 0xF4 && value >= 0x90)
        if (!valid) break
        continuations += 1
      }
      if (continuations === width - 1) {
        const second = bytes[index + 1]!
        const third = bytes[index + 2]
        const fourth = bytes[index + 3]
        if (width === 2) codePoint = ((first & 0x1F) << 6) | (second & 0x3F)
        if (width === 3) codePoint = ((first & 0xF) << 12) | ((second & 0x3F) << 6) | (third! & 0x3F)
        if (width === 4) {
          codePoint = ((first & 0x7) << 18) | ((second & 0x3F) << 12) | ((third! & 0x3F) << 6) | (fourth! & 0x3F)
        }
        index += width - 1
      } else {
        index += continuations
      }
    }
    if (codePoint <= 0xFFFF) output += String.fromCharCode(codePoint)
    else {
      const surrogate = codePoint - 0x10000
      output += String.fromCharCode(0xD800 + (surrogate >> 10), 0xDC00 + (surrogate & 0x3FF))
    }
  }
  return output
}

export const toBytes = (
  data: string | ArrayBuffer | Uint8Array,
  encoding: FsEncoding | undefined,
  syscall: FsOperationName
) => {
  if (typeof data === 'string') {
    normalizeEncoding(encoding, syscall)
    return encodeUtf8(data)
  }
  if (data instanceof Uint8Array) return new Uint8Array(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0))
  throw createFsError('EINVAL', syscall)
}

export const decodeBytes = (
  bytes: Uint8Array,
  encoding: FsEncoding | null | undefined,
  syscall: FsOperationName
) =>
  normalizeEncoding(encoding, syscall) == null
    ? bytes
    : decodeUtf8(bytes)

export const concatenateBytes = (
  chunks: readonly Uint8Array[],
  totalBytes: number
) => {
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
