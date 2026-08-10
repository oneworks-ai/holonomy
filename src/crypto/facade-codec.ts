import { copyInspectedBytes, inspectBytes } from './binary-intrinsics.js'
import { cryptoUtf8Length, encodeCryptoUtf8 } from './crypto-utf8.js'
import { cryptoError, invalidArgumentType } from './errors.js'
import { lowercaseString, stringCodeUnitAt } from './intrinsics.js'

export type CryptoInputEncoding = 'base64' | 'base64url' | 'hex' | 'utf-8' | 'utf8'
export type CryptoOutputEncoding = 'base64' | 'base64url' | 'hex'

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const base64Value = (codeUnit: number): number => {
  if (codeUnit >= 65 && codeUnit <= 90) return codeUnit - 65
  if (codeUnit >= 97 && codeUnit <= 122) return codeUnit - 71
  if (codeUnit >= 48 && codeUnit <= 57) return codeUnit + 4
  if (codeUnit === 43 || codeUnit === 45) return 62
  if (codeUnit === 47 || codeUnit === 95) return 63
  return -1
}

const hexValue = (codeUnit: number): number => {
  if (codeUnit >= 48 && codeUnit <= 57) return codeUnit - 48
  if (codeUnit >= 65 && codeUnit <= 70) return codeUnit - 55
  if (codeUnit >= 97 && codeUnit <= 102) return codeUnit - 87
  return -1
}

export const normalizeInputEncoding = (encoding: unknown): CryptoInputEncoding => {
  if (encoding === undefined) return 'utf8'
  if (typeof encoding !== 'string') return invalidArgumentType()
  const normalized = lowercaseString(encoding)
  if (
    normalized === 'base64' ||
    normalized === 'base64url' ||
    normalized === 'hex' ||
    normalized === 'utf-8' ||
    normalized === 'utf8'
  ) return normalized
  return invalidArgumentType()
}

export const normalizeOutputEncoding = (
  encoding: unknown
): CryptoOutputEncoding | undefined => {
  if (encoding === undefined) return undefined
  if (typeof encoding !== 'string') return invalidArgumentType()
  const normalized = lowercaseString(encoding)
  if (normalized === 'base64' || normalized === 'base64url' || normalized === 'hex') {
    return normalized
  }
  return invalidArgumentType()
}

const encodedByteLength = (value: string, encoding: CryptoInputEncoding): number => {
  if (encoding === 'utf8' || encoding === 'utf-8') return cryptoUtf8Length(value)
  if (encoding === 'hex') {
    let length = 0
    for (let index = 0; index + 1 < value.length; index += 2) {
      if (hexValue(stringCodeUnitAt(value, index)) < 0 || hexValue(stringCodeUnitAt(value, index + 1)) < 0) break
      length += 1
    }
    return length
  }
  let sextets = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = stringCodeUnitAt(value, index)
    if (code === 61) break
    if (base64Value(code) >= 0) sextets += 1
  }
  return Math.floor(sextets / 4) * 3 + (sextets % 4 >= 2 ? sextets % 4 - 1 : 0)
}

const decodeHex = (value: string, byteLength: number): Uint8Array => {
  const output = new Uint8Array(byteLength)
  let offset = 0
  for (let index = 0; index + 1 < value.length && offset < output.length; index += 2) {
    const high = hexValue(stringCodeUnitAt(value, index))
    const low = hexValue(stringCodeUnitAt(value, index + 1))
    if (high < 0 || low < 0) break
    output[offset] = (high << 4) | low
    offset += 1
  }
  return output
}

const decodeBase64 = (value: string, byteLength: number): Uint8Array => {
  const output = new Uint8Array(byteLength)
  const sextets = new Uint8Array(4)
  let offset = 0
  let count = 0
  const flush = (): void => {
    if (count < 2) return
    const packed = (sextets[0]! << 18) | (sextets[1]! << 12) | ((sextets[2] ?? 0) << 6) | (sextets[3] ?? 0)
    output[offset] = packed >>> 16
    offset += 1
    if (count >= 3 && offset < output.length) {
      output[offset] = packed >>> 8
      offset += 1
    }
    if (count === 4 && offset < output.length) {
      output[offset] = packed
      offset += 1
    }
    count = 0
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = stringCodeUnitAt(value, index)
    if (code === 61) break
    const sextet = base64Value(code)
    if (sextet < 0) continue
    sextets[count] = sextet
    count += 1
    if (count === 4) flush()
  }
  flush()
  return output
}

export const copyBoundedInput = (
  value: string | Uint8Array,
  encoding: CryptoInputEncoding | undefined,
  maximumBytes: number
): Uint8Array => {
  if (typeof value !== 'string') {
    const snapshot = inspectBytes(value)
    if (snapshot.byteLength > maximumBytes) {
      throw cryptoError('ERR_HOLONOMY_RESOURCE_EXHAUSTED')
    }
    return copyInspectedBytes(snapshot)
  }
  const normalized = normalizeInputEncoding(encoding)
  const byteLength = encodedByteLength(value, normalized)
  if (byteLength > maximumBytes) throw cryptoError('ERR_HOLONOMY_RESOURCE_EXHAUSTED')
  if (normalized === 'utf8' || normalized === 'utf-8') return encodeCryptoUtf8(value)
  return normalized === 'hex' ? decodeHex(value, byteLength) : decodeBase64(value, byteLength)
}

export const inspectBoundedBytes = (value: Uint8Array, maximumBytes: number): Uint8Array => {
  const snapshot = inspectBytes(value)
  if (snapshot.byteLength > maximumBytes) {
    throw cryptoError('ERR_HOLONOMY_RESOURCE_EXHAUSTED')
  }
  return copyInspectedBytes(snapshot)
}

export const encodeCryptoOutput = (bytes: Uint8Array, encoding: CryptoOutputEncoding): string => {
  const snapshot = inspectBytes(bytes)
  const input = snapshot.bytes
  const byteLength = snapshot.byteLength
  if (encoding === 'hex') {
    let output = ''
    for (let index = 0; index < byteLength; index += 1) {
      const byte = input[index]!
      output += '0123456789abcdef'[byte >>> 4]
      output += '0123456789abcdef'[byte & 0x0F]
    }
    return output
  }
  let output = ''
  for (let index = 0; index < byteLength; index += 3) {
    const first = input[index]!
    const second = input[index + 1]
    const third = input[index + 2]
    const packed = (first << 16) | ((second ?? 0) << 8) | (third ?? 0)
    output += BASE64_ALPHABET[(packed >>> 18) & 0x3F]
    output += BASE64_ALPHABET[(packed >>> 12) & 0x3F]
    output += second === undefined ? '=' : BASE64_ALPHABET[(packed >>> 6) & 0x3F]
    output += third === undefined ? '=' : BASE64_ALPHABET[packed & 0x3F]
  }
  if (encoding === 'base64url') {
    let url = ''
    for (let index = 0; index < output.length; index += 1) {
      const code = stringCodeUnitAt(output, index)
      if (code === 61) break
      url += code === 43 ? '-' : code === 47 ? '_' : output[index]!
    }
    return url
  }
  return output
}
