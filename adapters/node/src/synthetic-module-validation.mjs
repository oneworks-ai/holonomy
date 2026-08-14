import { Buffer } from 'node:buffer'

import { copyJsonValue, freezeJsonValue } from './json-value.mjs'

const MAX_SYNTHETIC_EXPORTS = 256
const MAX_SYNTHETIC_MODULES = 64
const MAX_SYNTHETIC_REGISTRY_BYTES = 8 * 1024 * 1024
const MAX_URL_BYTES = 4 * 1024
const EXPORT_NAME = /^[$A-Z_a-z][$\w]*$/u

const invalid = message => {
  throw new TypeError(message)
}

export const readSyntheticModules = value => {
  if (value == null) return Object.freeze(Object.create(null))
  if (typeof value !== 'object' || Array.isArray(value)) invalid('Invalid Node Runtime synthetic registry')
  const output = Object.create(null)
  const specifiers = Object.keys(value)
  if (specifiers.length > MAX_SYNTHETIC_MODULES) invalid('Node Runtime synthetic registry exceeds the limit')
  let bytes = 0
  for (const specifier of specifiers) {
    if (!/^node:[a-z\d][a-z\d_./-]*$/u.test(specifier) || Buffer.byteLength(specifier) > MAX_URL_BYTES) {
      invalid('Node Runtime synthetic module must use a canonical node: specifier')
    }
    const namespace = value[specifier]
    if (namespace == null || typeof namespace !== 'object' || Array.isArray(namespace)) {
      invalid('Invalid Node Runtime synthetic namespace')
    }
    const names = Object.keys(namespace)
    if (names.length > MAX_SYNTHETIC_EXPORTS || names.some(name => !EXPORT_NAME.test(name))) {
      invalid('Invalid Node Runtime synthetic exports')
    }
    const copied = Object.create(null)
    for (const name of names) {
      copied[name] = freezeJsonValue(copyJsonValue(namespace[name], 'synthetic export'))
      bytes += Buffer.byteLength(JSON.stringify(copied[name]))
      if (bytes > MAX_SYNTHETIC_REGISTRY_BYTES) invalid('Node Runtime synthetic registry exceeds the byte limit')
    }
    output[specifier] = Object.freeze(copied)
  }
  return Object.freeze(output)
}
