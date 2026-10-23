import { getTestOwnDescriptor, getTestPrototype, isTestValue, ownTestKeys } from './intrinsics.js'

const dateValue = Date.prototype.getTime
const regexpSource = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')!.get!
const regexpFlags = ['hasIndices', 'global', 'ignoreCase', 'multiline', 'dotAll', 'unicode', 'unicodeSets', 'sticky']
  .map(key => Object.getOwnPropertyDescriptor(RegExp.prototype, key)?.get).filter(getter => getter != null)
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!
const mapEntries = Map.prototype.entries
const setValues = Set.prototype.values
const mapNext = Object.getPrototypeOf(new Map().entries()).next
const setNext = Object.getPrototypeOf(new Set().values()).next
const view = ArrayBuffer.isView
const arrayBufferSize = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!
const sharedBufferType = typeof SharedArrayBuffer === 'undefined' ? undefined : SharedArrayBuffer
const sharedBufferSize = sharedBufferType == null
  ? undefined
  : Object.getOwnPropertyDescriptor(sharedBufferType.prototype, 'byteLength')!.get!
const dataViewType = DataView
const dataViewSize = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!
const dataViewOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!
const NativeUint8Array = Uint8Array
const hasInstance = Function.prototype[Symbol.hasInstance]
const dateType = Date
const regexpType = RegExp
const mapType = Map
const setType = Set
const bufferType = ArrayBuffer
const weakMapType = WeakMap
const weakSetType = WeakSet
const errorType = Error
const primitiveTypes = [Number, String, Boolean, BigInt, Symbol].map(type => [type, type.prototype.valueOf] as const)

type Pair = readonly [object, object]
type Compare = (actual: unknown, expected: unknown) => boolean
const weakMapHas = WeakMap.prototype.has
const weakSetHas = WeakSet.prototype.has
const brandKey = {}
const brandProbes: ReadonlyArray<readonly [object, (this: object) => unknown]> = [
  [dateType, dateValue],
  [regexpType, regexpSource],
  [mapType, mapSize],
  [setType, setSize],
  [bufferType, arrayBufferSize],
  [dataViewType, dataViewSize],
  [weakMapType, function() {
    return weakMapHas.call(this as WeakMap<object, unknown>, brandKey)
  }],
  [weakSetType, function() {
    return weakSetHas.call(this as WeakSet<object>, brandKey)
  }],
  ...primitiveTypes
]
const instance = (type: object, value: object) => {
  const probe = brandProbes.find(([constructor]) => constructor === type)?.[1] ??
    (type === sharedBufferType ? sharedBufferSize : undefined)
  if (probe == null) return hasInstance.call(type, value)
  try {
    probe.call(value)
    return true
  } catch {
    return false
  }
}

const unordered = (actual: object, expected: object, map: boolean, compare: Compare, seen: Pair[]): boolean => {
  const size = map ? mapSize : setSize
  if (size.call(actual) !== size.call(expected)) return false
  const values = map ? mapEntries : setValues
  const next = map ? mapNext : setNext
  const remaining: unknown[] = []
  const expectedIterator = values.call(expected as never)
  for (let item = next.call(expectedIterator); !item.done; item = next.call(expectedIterator)) {
    remaining.push(item.value)
  }
  const actualIterator = values.call(actual as never)
  for (let item = next.call(actualIterator); !item.done; item = next.call(actualIterator)) {
    let matched = false
    for (let index = 0; index < remaining.length; index++) {
      const checkpoint = seen.length
      const a = item.value as unknown[]
      const b = remaining[index] as unknown[]
      if (map ? compare(a[0], b[0]) && compare(a[1], b[1]) : compare(a, b)) {
        remaining.splice(index, 1)
        matched = true
        break
      }
      seen.length = checkpoint
    }
    if (!matched) return false
  }
  return true
}

const builtins = (actual: object, expected: object, compare: Compare, seen: Pair[]): boolean => {
  for (const [type] of brandProbes) if (instance(type, actual) !== instance(type, expected)) return false
  if (sharedBufferType != null && instance(sharedBufferType, actual) !== instance(sharedBufferType, expected)) {
    return false
  }
  if (instance(errorType, actual)) {
    const a = actual as Error
    const b = expected as Error
    if (!compare(a.name, b.name) || !compare(a.message, b.message)) return false
  }
  if (instance(dateType, actual) && dateValue.call(actual) !== dateValue.call(expected)) return false
  if (instance(regexpType, actual)) {
    if (regexpSource.call(actual) !== regexpSource.call(expected)) return false
    for (const getter of regexpFlags) if (getter!.call(actual) !== getter!.call(expected)) return false
  }
  if (instance(mapType, actual) && !unordered(actual, expected, true, compare, seen)) return false
  if (instance(setType, actual) && !unordered(actual, expected, false, compare, seen)) return false
  if (instance(weakMapType, actual) || instance(weakSetType, actual)) return false
  for (const [type, valueOf] of primitiveTypes) {
    const extract = valueOf as (this: object) => unknown
    if (instance(type, actual) && !isTestValue(extract.call(actual), extract.call(expected))) return false
  }
  const bufferSize = instance(bufferType, actual)
    ? arrayBufferSize
    : sharedBufferType != null && instance(sharedBufferType, actual)
    ? sharedBufferSize
    : undefined
  if (bufferSize != null) {
    const length = bufferSize.call(actual)
    if (length !== bufferSize.call(expected)) return false
    const a = new NativeUint8Array(actual as ArrayBuffer)
    const b = new NativeUint8Array(expected as ArrayBuffer)
    for (let index = 0; index < length; index++) if (a[index] !== b[index]) return false
  }
  if (instance(dataViewType, actual)) {
    const length = dataViewSize.call(actual)
    if (!view(expected) || length !== dataViewSize.call(expected)) return false
    const a = new NativeUint8Array(dataViewBuffer.call(actual), dataViewOffset.call(actual), length)
    const b = new NativeUint8Array(dataViewBuffer.call(expected), dataViewOffset.call(expected), length)
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false
  }
  return true
}

const compareValue = (actual: unknown, expected: unknown, seen: Pair[], depth: number): boolean => {
  if (isTestValue(actual, expected)) return true
  if (actual == null || expected == null || typeof actual !== 'object' || typeof expected !== 'object') return false
  if (depth > 512 || getTestPrototype(actual) !== getTestPrototype(expected)) return false
  if (seen.some(pair => pair[0] === actual && pair[1] === expected)) return true
  const checkpoint = seen.length
  seen.push([actual, expected])
  const compare = (a: unknown, b: unknown) => compareValue(a, b, seen, depth + 1)
  let equal = false
  try {
    if (!builtins(actual, expected, compare, seen)) return false
    const keys = ownTestKeys(actual).filter(key =>
      !instance(errorType, actual) || !['stack', 'name', 'message'].includes(key as string)
    )
    const other = ownTestKeys(expected).filter(key =>
      !instance(errorType, expected) || !['stack', 'name', 'message'].includes(key as string)
    )
    if (keys.length !== other.length) return false
    for (const key of keys) {
      if (!other.includes(key)) return false
      const a = getTestOwnDescriptor(actual, key)
      const b = getTestOwnDescriptor(expected, key)
      if (a == null || b == null || !('value' in a) || !('value' in b) || !compare(a.value, b.value)) return false
    }
    equal = true
    return true
  } finally {
    if (!equal) seen.length = checkpoint
  }
}

export const deepEqualValue = (actual: unknown, expected: unknown): boolean => compareValue(actual, expected, [], 0)
