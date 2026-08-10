import { invalidArgumentType } from './errors.js'
import { callIntrinsic, createNullRecord, freeze } from './intrinsics.js'

const RuntimeArray = Array
const RuntimeObject = Object
const RuntimePromise = Promise
const RuntimeReflect = Reflect
const arrayIncludesIntrinsic = RuntimeArray.prototype.includes
const objectDefinePropertyIntrinsic = RuntimeObject.defineProperty
const objectGetOwnPropertyDescriptorIntrinsic = RuntimeObject.getOwnPropertyDescriptor
const objectGetOwnPropertyDescriptorsIntrinsic = RuntimeObject.getOwnPropertyDescriptors
const objectGetPrototypeOfIntrinsic = RuntimeObject.getPrototypeOf
const objectHasOwnPropertyIntrinsic = RuntimeObject.prototype.hasOwnProperty
const promiseThenIntrinsic = RuntimePromise.prototype.then
const reflectDeletePropertyIntrinsic = RuntimeReflect.deleteProperty
const reflectOwnKeysIntrinsic = RuntimeReflect.ownKeys
const safePromiseConstructor = createNullRecord()
callIntrinsic(objectDefinePropertyIntrinsic, RuntimeObject, [
  safePromiseConstructor,
  Symbol.species,
  {
    configurable: false,
    enumerable: false,
    value: RuntimePromise,
    writable: false
  }
])
freeze(safePromiseConstructor)

export type StrictRecord = Readonly<Record<string, unknown>>

export const snapshotStrictRecord = (
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = []
): StrictRecord => {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return invalidArgumentType()
  }
  try {
    const prototype = callIntrinsic(objectGetPrototypeOfIntrinsic, RuntimeObject, [value])
    if (prototype !== RuntimeObject.prototype && prototype !== null) return invalidArgumentType()
    const descriptors = callIntrinsic(objectGetOwnPropertyDescriptorsIntrinsic, RuntimeObject, [
      value
    ]) as Record<PropertyKey, PropertyDescriptor>
    const keys = callIntrinsic(reflectOwnKeysIntrinsic, RuntimeReflect, [descriptors]) as PropertyKey[]
    const snapshot = createNullRecord()
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!
      if (
        typeof key !== 'string' ||
        callIntrinsic(arrayIncludesIntrinsic, allowedKeys, [key]) !== true
      ) {
        return invalidArgumentType()
      }
      const descriptor = descriptors[key]
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return invalidArgumentType()
      }
      snapshot[key] = descriptor.value
    }
    for (let index = 0; index < requiredKeys.length; index += 1) {
      const required = requiredKeys[index]!
      if (callIntrinsic(objectHasOwnPropertyIntrinsic, snapshot, [required]) !== true) {
        return invalidArgumentType()
      }
    }
    return freeze(snapshot)
  } catch {
    return invalidArgumentType()
  }
}

export const hasThenProperty = (value: unknown): boolean => {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
  try {
    let current: object | null = value as object
    for (let depth = 0; current !== null && depth < 32; depth += 1) {
      const descriptor = callIntrinsic(objectGetOwnPropertyDescriptorIntrinsic, RuntimeObject, [
        current,
        'then'
      ]) as PropertyDescriptor | undefined
      if (descriptor !== undefined) return true
      current = callIntrinsic(objectGetPrototypeOfIntrinsic, RuntimeObject, [current]) as
        | object
        | null
    }
    return current !== null
  } catch {
    return true
  }
}

const attachConfigurablePromiseRejectionObserver = (value: object): boolean => {
  let constructorDescriptor: PropertyDescriptor | undefined
  try {
    constructorDescriptor = callIntrinsic(
      objectGetOwnPropertyDescriptorIntrinsic,
      RuntimeObject,
      [value, 'constructor']
    ) as PropertyDescriptor | undefined
    if (constructorDescriptor !== undefined && !constructorDescriptor.configurable) return false
    callIntrinsic(objectDefinePropertyIntrinsic, RuntimeObject, [value, 'constructor', {
      configurable: true,
      enumerable: constructorDescriptor?.enumerable ?? false,
      value: safePromiseConstructor,
      writable: true
    }])
  } catch {
    return false
  }
  try {
    callIntrinsic(promiseThenIntrinsic, value, [
      () => undefined,
      () => undefined
    ])
    return true
  } catch {
    return false
  } finally {
    try {
      if (constructorDescriptor === undefined) {
        callIntrinsic(reflectDeletePropertyIntrinsic, RuntimeReflect, [value, 'constructor'])
      } else {
        callIntrinsic(objectDefinePropertyIntrinsic, RuntimeObject, [
          value,
          'constructor',
          constructorDescriptor
        ])
      }
    } catch {
      // Provider objects are untrusted; restoration failure must not expose native detail.
    }
  }
}

/**
 * Detects forbidden async provider returns without reading an arbitrary `then` getter.
 * Native Promise observation is best effort: the provider owns rejection observation
 * before returning, because an unreplaceable hostile constructor can block PerformPromiseThen.
 */
export const isForbiddenAsyncOrThenableReturn = (value: unknown): boolean => {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
  try {
    callIntrinsic(promiseThenIntrinsic, value, [
      () => undefined,
      () => undefined
    ])
    return true
  } catch {
    if (attachConfigurablePromiseRejectionObserver(value)) return true
    return hasThenProperty(value)
  }
}

export const defineCryptoGlobal = (target: object, crypto: unknown): void => {
  try {
    callIntrinsic(objectDefinePropertyIntrinsic, RuntimeObject, [target, 'crypto', {
      configurable: true,
      enumerable: true,
      value: crypto,
      writable: false
    }])
  } catch {
    return invalidArgumentType()
  }
}
