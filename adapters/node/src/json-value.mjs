import { Buffer } from 'node:buffer'

const MAX_DEPTH = 32
const MAX_NODES = 20_000
const MAX_STRING_BYTES = 8 * 1024 * 1024

const fail = label => {
  throw new TypeError(`Invalid ${label}`)
}

export function copyJsonValue(input, label = 'JSON value') {
  const state = { nodes: 0 }
  return copy(input, label, state, 0)
}

function copy(value, label, state, depth) {
  if (depth > MAX_DEPTH || ++state.nodes > MAX_NODES) fail(label)
  if (value == null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : fail(label)
  if (typeof value === 'string') {
    return Buffer.byteLength(value) <= MAX_STRING_BYTES ? value : fail(label)
  }
  if (typeof value !== 'object') return fail(label)
  if (Array.isArray(value)) return copyArray(value, label, state, depth)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return fail(label)
  const output = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return fail(label)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) return fail(label)
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: copy(descriptor.value, label, state, depth + 1),
      writable: true
    })
  }
  return output
}

function copyArray(value, label, state, depth) {
  if (value.length > MAX_NODES) return fail(label)
  const output = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) return fail(label)
    output.push(copy(descriptor.value, label, state, depth + 1))
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail(label)
  return output
}

export function freezeJsonValue(value) {
  if (value != null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeJsonValue(value[key])
    Object.freeze(value)
  }
  return value
}
