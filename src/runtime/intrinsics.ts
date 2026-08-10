import { isRuntimeComposerError, runtimeComposerError } from './errors.js'

const ARRAY_IS_ARRAY = Array.isArray
const ARRAY_PROTOTYPE = Array.prototype
const CREATE = Object.create
const DEFINE = Object.defineProperty
const DELETE_PROPERTY = Reflect.deleteProperty
const FREEZE = Object.freeze
const GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor
const GET_OWN_PROPERTY_NAMES = Object.getOwnPropertyNames
const GET_OWN_PROPERTY_SYMBOLS = Object.getOwnPropertySymbols
const GET_PROTOTYPE_OF = Object.getPrototypeOf
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger
const OBJECT_PROTOTYPE = Object.prototype
const STRING = String

/** Composer-private clean record construction; this module is not package-exported. */
export const createRuntimeRecord = (prototype: object | null = null): Record<string, unknown> =>
  CREATE(prototype) as Record<string, unknown>
/** Composer-private own-data output definition using import-time intrinsics. */
export const defineRuntimeData = (target: object, key: string, value: unknown) =>
  DEFINE(target, key, { configurable: false, enumerable: true, value, writable: false })
export const getRuntimeOwnDescriptor = (target: object, key: string) => GET_OWN_PROPERTY_DESCRIPTOR(target, key)
export const freezeRuntimeValue = <T>(value: T): Readonly<T> => FREEZE(value)
export const runtimeString = (value: unknown): string => STRING(value)

/**
 * Leaves may still build ordinary source registries. Keep known synthetic names
 * from inherited setters while the synchronous registry factories run.
 */
export const withUnshadowedObjectPrototypeKeys = <T>(keys: readonly string[], create: () => T): T => {
  const descriptors: (PropertyDescriptor | undefined)[] = []
  try {
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index] as string
      const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(OBJECT_PROTOTYPE, key)
      defineRuntimeData(descriptors, runtimeString(index), descriptor)
      if (descriptor !== undefined && !DELETE_PROPERTY(OBJECT_PROTOTYPE, key)) invalid()
    }
    return create()
  } finally {
    for (let index = 0; index < keys.length; index += 1) {
      const descriptor = descriptors[index]
      if (descriptor !== undefined) DEFINE(OBJECT_PROTOTYPE, keys[index] as string, descriptor)
    }
  }
}

const invalid = (): never => {
  throw runtimeComposerError('runtime_composer.invalid_options')
}
const contains = (values: readonly string[], value: string) => {
  for (let index = 0; index < values.length; index += 1) if (values[index] === value) return true
  return false
}
const caught = (error: unknown): never => {
  if (isRuntimeComposerError(error)) throw error
  return invalid()
}

/** Exact own-data snapshot with a fresh ordinary object safe from inherited setters. */
export const snapshotRecord = (
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = []
): Readonly<Record<string, unknown>> => {
  try {
    if (
      value == null || typeof value !== 'object' || ARRAY_IS_ARRAY(value) ||
      GET_PROTOTYPE_OF(value) !== OBJECT_PROTOTYPE
    ) invalid()
    const names = GET_OWN_PROPERTY_NAMES(value)
    if (GET_OWN_PROPERTY_SYMBOLS(value).length !== 0) invalid()
    const output = createRuntimeRecord(OBJECT_PROTOTYPE)
    for (let index = 0; index < names.length; index += 1) {
      const key = names[index] as string
      if (!contains(allowed, key)) invalid()
      const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(value, key)
      if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) invalid()
      defineRuntimeData(output, key, descriptor!.value)
    }
    for (let index = 0; index < required.length; index += 1) {
      if (GET_OWN_PROPERTY_DESCRIPTOR(output, required[index] as string) == null) invalid()
    }
    return FREEZE(output)
  } catch (error) {
    return caught(error)
  }
}

export const snapshotArray = (value: unknown, maximum = 256): readonly unknown[] => {
  try {
    if (!ARRAY_IS_ARRAY(value) || GET_PROTOTYPE_OF(value) !== ARRAY_PROTOTYPE) invalid()
    const length = GET_OWN_PROPERTY_DESCRIPTOR(value, 'length')?.value
    if (
      !NUMBER_IS_SAFE_INTEGER(length) || length < 0 || length > maximum ||
      GET_OWN_PROPERTY_SYMBOLS(value).length !== 0 || GET_OWN_PROPERTY_NAMES(value).length !== length + 1
    ) invalid()
    const output: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(value, runtimeString(index))
      if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) invalid()
      defineRuntimeData(output, runtimeString(index), descriptor!.value)
    }
    return FREEZE(output)
  } catch (error) {
    return caught(error)
  }
}

export const snapshotCapabilityArray = (value: unknown): readonly string[] => {
  const values = snapshotArray(value)
  const output: string[] = []
  for (let index = 0; index < values.length; index += 1) {
    if (typeof values[index] !== 'string') invalid()
    defineRuntimeData(output, runtimeString(index), values[index])
  }
  return FREEZE(output)
}
export const snapshotOptionalRecord = (value: unknown, allowed: readonly string[]) =>
  value === undefined ? undefined : snapshotRecord(value, allowed)
export const hasCapability = contains
export const capabilitiesAlign = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && (() => {
    for (let index = 0; index < left.length; index += 1) if (!contains(right, left[index] as string)) return false
    return true
  })()
export const invalidOptions = (): never => invalid()
