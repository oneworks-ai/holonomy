import { invalidPolicy } from './errors.js'

export const MAX_POLICY_BYTES = 1024 * 1024
export const MAX_DEPTH = 16
export const MAX_CONTAINER_ENTRIES = 1024

export type JsonRecord = Record<string, unknown>

export const record = (value: unknown): JsonRecord => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return invalidPolicy()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return invalidPolicy()
  return value as JsonRecord
}

export const exact = (value: unknown, keys: readonly string[]): JsonRecord => {
  const output = record(value)
  const actual = Object.keys(output)
  if (actual.length > MAX_CONTAINER_ENTRIES || actual.some(key => !keys.includes(key))) {
    return invalidPolicy()
  }
  return output
}

export const required = (value: JsonRecord, key: string): unknown => {
  if (!Object.hasOwn(value, key)) return invalidPolicy()
  return value[key]
}

export const integer = (value: unknown, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return invalidPolicy()
  }
  return value as number
}

export const finiteNumber = (value: unknown, minimum: number, maximum: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    return invalidPolicy()
  }
  return value
}

export const boundedText = (value: unknown, maximumBytes: number, allowEmpty = false): string => {
  if (
    typeof value !== 'string' || (!allowEmpty && value.length === 0) ||
    utf8ByteLength(value) > maximumBytes
  ) return invalidPolicy()
  return value
}

export const boolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') return invalidPolicy()
  return value
}

export const string = (value: unknown, maximumBytes = 128): string => {
  if (typeof value !== 'string' || value.length === 0 || utf8ByteLength(value) > maximumBytes) {
    return invalidPolicy()
  }
  return value
}

export const literal = <T extends string>(value: unknown, values: readonly T[]): T => {
  if (typeof value !== 'string' || !values.includes(value as T)) return invalidPolicy()
  return value as T
}

export const array = (value: unknown, minimum = 0, maximum = MAX_CONTAINER_ENTRIES): unknown[] => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return invalidPolicy()
  return value
}

const compareCodePoints = (left: string, right: string): number => {
  const leftPoints = [...left]
  const rightPoints = [...right]
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}

export const stringSet = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  minimum: number,
  maximum: number
): readonly T[] => {
  const values = array(value, minimum, maximum).map(item => literal(item, allowed))
  if (new Set(values).size !== values.length) return invalidPolicy()
  return Object.freeze(values.sort(compareCodePoints))
}

export const identifier = (value: unknown, maximumBytes = 128): string => {
  const result = string(value, maximumBytes)
  if (!/^[A-Za-z0-9][\w.-]*$/u.test(result)) return invalidPolicy()
  return result
}

export const deepFreeze = <T>(value: T): T => {
  if (value == null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const item of Array.isArray(value) ? value : Object.values(value)) deepFreeze(item)
  return Object.freeze(value)
}

export const inspectJsonShape = (value: unknown, depth = 0): void => {
  if (depth > MAX_DEPTH) return invalidPolicy()
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidPolicy()
    return
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CONTAINER_ENTRIES) invalidPolicy()
    for (const item of value) inspectJsonShape(item, depth + 1)
    return
  }
  const object = record(value)
  const keys = Object.keys(object)
  if (keys.length > MAX_CONTAINER_ENTRIES) invalidPolicy()
  for (const key of keys) inspectJsonShape(object[key], depth + 1)
}

export const utf8ByteLength = (value: string): number => {
  let bytes = 0
  for (const character of value) {
    const point = character.codePointAt(0)!
    bytes += point <= 0x7F ? 1 : point <= 0x7FF ? 2 : point <= 0xFFFF ? 3 : 4
  }
  return bytes
}
