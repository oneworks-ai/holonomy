import { sha256Hex } from '../module-loader/sha256.js'
import { encodeUtf8 } from '../node-compat/utf8.js'
import { invalidPolicy } from './errors.js'

export type CanonicalJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalJsonValue[]
  | Readonly<{ [key: string]: CanonicalJsonValue }>

const serialize = (value: CanonicalJsonValue): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalidPolicy()
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`
  const record = value as Readonly<Record<string, CanonicalJsonValue>>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${serialize(record[key]!)}`).join(',')}}`
}

export const canonicalJson = (value: CanonicalJsonValue): string => serialize(value)

export const canonicalDigest = (value: CanonicalJsonValue): string => sha256Hex(encodeUtf8(canonicalJson(value)))
