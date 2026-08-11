import { Buffer } from 'node:buffer'

const MAX_ARG_BYTES = 16 * 1024
const MAX_ARG_COUNT = 256
const MAX_ARGV_BYTES = 256 * 1024
const MAX_ENV_BYTES = 1024 * 1024
const MAX_ENV_ENTRIES = 256
const MAX_ENV_KEY_BYTES = 256
const MAX_ENV_VALUE_BYTES = 64 * 1024

const invalid = message => {
  throw new TypeError(message)
}

export const readArgv = (value, entryUrl) => {
  const input = value ?? ['holonomy', entryUrl]
  if (!Array.isArray(input) || input.length > MAX_ARG_COUNT) invalid('Invalid Node Runtime argv')
  let bytes = 0
  const output = []
  for (const argument of input) {
    if (typeof argument !== 'string' || argument.includes('\0')) invalid('Invalid Node Runtime argv')
    const argumentBytes = Buffer.byteLength(argument)
    bytes += argumentBytes
    if (argumentBytes > MAX_ARG_BYTES || bytes > MAX_ARGV_BYTES) {
      invalid('Node Runtime argv exceeds the byte limit')
    }
    output.push(argument)
  }
  return Object.freeze(output)
}

export const readEnv = value => {
  if (value == null) return Object.freeze(Object.create(null))
  if (typeof value !== 'object' || Array.isArray(value)) invalid('Invalid Node Runtime env')
  const entries = Object.entries(value)
  if (entries.length > MAX_ENV_ENTRIES) invalid('Node Runtime env exceeds the entry limit')
  let bytes = 0
  const output = Object.create(null)
  for (const [key, entryValue] of entries) {
    if (
      key.length === 0 || key.includes('\0') || key.includes('=') || typeof entryValue !== 'string' ||
      entryValue.includes('\0')
    ) invalid('Invalid Node Runtime env')
    const keyBytes = Buffer.byteLength(key)
    const valueBytes = Buffer.byteLength(entryValue)
    bytes += keyBytes + valueBytes
    if (keyBytes > MAX_ENV_KEY_BYTES || valueBytes > MAX_ENV_VALUE_BYTES || bytes > MAX_ENV_BYTES) {
      invalid('Node Runtime env exceeds the byte limit')
    }
    output[key] = entryValue
  }
  return Object.freeze(output)
}
