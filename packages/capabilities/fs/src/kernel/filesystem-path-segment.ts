import { invalidPolicy } from '@holonomyjs/runtime/kernel/errors'
import type { JsonSchema } from '@holonomyjs/runtime/kernel/schema-primitives'
import { string } from '@holonomyjs/runtime/kernel/validation'
import { canonicalVirtualPath } from './normalize-filesystem.js'

// Canonical URI spelling, not an identifier: hidden names and encoded UTF-8
// remain valid. Each encoded octet counts once toward the native name bound.
const continuation = '%[89AB][0-9A-F]'
const encodedAscii = '%(?:0[1-9A-F]|1[0-9A-F]|20|2[2-6BC]|3[A-F]|40|5[BDE]|60|7[BCDF])'
const twoBytes = `%(?:C[2-9A-F]|D[0-9A-F])${continuation}`
const threeBytes = `(?:%E0%[AB][0-9A-F]|%E[1-9ABCEF]${continuation}|%ED%[89][0-9A-F])${continuation}`
const fourBytes = `(?:%F0%[9AB][0-9A-F]|%F[1-3]${continuation}|%F4%8[0-9A-F])${continuation}${continuation}`
const canonicalPattern = `^(?!\\.{1,2}$)(?:[\\w!'()*.~-]|${encodedAscii}|${twoBytes}|${threeBytes}|${fourBytes})+$`
const byteCountPattern = "^(?:[\\w!'()*.~-]|%[0-9A-F]{2}){1,255}$"
const canonical = new RegExp(canonicalPattern, 'u')
const byteCount = new RegExp(byteCountPattern, 'u')

export const FS_CANONICAL_SEGMENT_V1_SCHEMA: JsonSchema = Object.freeze({
  allOf: [
    { pattern: canonicalPattern },
    { pattern: byteCountPattern }
  ],
  maxLength: 765,
  minLength: 1,
  type: 'string'
})

export const canonicalFilesystemPrefixSegmentV1 = (value: unknown): string => {
  const segment = string(value, 765)
  if (!canonical.test(segment) || !byteCount.test(segment)) return invalidPolicy()
  canonicalVirtualPath(`holo-fs://segment/${segment}`)
  return segment
}
