import { invalidEncoding } from './errors.js'
import { decodeUtf8, encodeUtf8 } from './utf8.js'

export { decodeUtf8, encodeUtf8 } from './utf8.js'

export type BufferEncoding = 'base64' | 'base64url' | 'hex' | 'utf8'

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export const normalizeEncoding = (encoding = 'utf8'): BufferEncoding => {
  const normalized = encoding.toLowerCase()
  if (normalized === 'utf-8') {
    return 'utf8'
  }
  if (
    normalized === 'utf8' ||
    normalized === 'base64' ||
    normalized === 'base64url' ||
    normalized === 'hex'
  ) {
    return normalized
  }
  return invalidEncoding(encoding)
}

export const encodeBufferString = (
  value: string,
  encoding?: string
): Uint8Array => {
  switch (normalizeEncoding(encoding)) {
    case 'base64':
    case 'base64url':
      return decodeBase64(value)
    case 'hex':
      return decodeHex(value)
    case 'utf8':
      return encodeUtf8(value)
  }
}

export const decodeBufferBytes = (
  bytes: Uint8Array,
  encoding?: string
): string => {
  switch (normalizeEncoding(encoding)) {
    case 'base64':
      return encodeBase64(bytes, false)
    case 'base64url':
      return encodeBase64(bytes, true)
    case 'hex':
      return encodeHex(bytes)
    case 'utf8':
      return decodeUtf8(bytes)
  }
}

export const encodeBase64 = (
  bytes: Uint8Array,
  urlSafe: boolean
): string => {
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    const packed = (first << 16) | ((second ?? 0) << 8) | (third ?? 0)
    output += BASE64_ALPHABET[(packed >> 18) & 0x3F]
    output += BASE64_ALPHABET[(packed >> 12) & 0x3F]
    output += second === undefined ? '=' : BASE64_ALPHABET[(packed >> 6) & 0x3F]
    output += third === undefined ? '=' : BASE64_ALPHABET[packed & 0x3F]
  }
  if (urlSafe) {
    return output.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  }
  return output
}

export const decodeBase64 = (value: string): Uint8Array => {
  const sextets: number[] = []
  const bytes: number[] = []
  const flush = () => {
    const packed = (sextets[0]! << 18) |
      (sextets[1]! << 12) |
      ((sextets[2] ?? 0) << 6) |
      (sextets[3] ?? 0)
    bytes.push((packed >> 16) & 0xFF)
    if (sextets.length >= 3) bytes.push((packed >> 8) & 0xFF)
    if (sextets.length === 4) bytes.push(packed & 0xFF)
    sextets.length = 0
  }
  for (const character of value) {
    if (character === '=') break
    const normalized = character === '-'
      ? '+'
      : character === '_'
      ? '/'
      : character
    const sextet = BASE64_ALPHABET.indexOf(normalized)
    if (sextet < 0) continue
    sextets.push(sextet)
    if (sextets.length === 4) flush()
  }
  if (sextets.length >= 2) flush()
  return Uint8Array.from(bytes)
}

export const base64ByteLength = (value: string): number => {
  let length = value.length
  if (length > 0 && value.charCodeAt(length - 1) === 61) length -= 1
  if (
    length > 0 &&
    value.charCodeAt(length - 1) === 61
  ) {
    length -= 1
  }
  return Math.floor(length * 3 / 4)
}

export const encodeHex = (bytes: Uint8Array): string => {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export const decodeHex = (value: string): Uint8Array => {
  const bytes: number[] = []
  for (let index = 0; index + 1 < value.length; index += 2) {
    const pair = value.slice(index, index + 2)
    if (!/^[\da-f]{2}$/iu.test(pair)) {
      break
    }
    bytes.push(Number.parseInt(pair, 16))
  }
  return Uint8Array.from(bytes)
}
