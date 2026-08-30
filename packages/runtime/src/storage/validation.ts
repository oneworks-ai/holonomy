import { utf8ByteLength } from '../node-compat/utf8.js'
import { createStorageError } from './errors.js'

import type { NativeResourceHandle, NativeResult } from '../native-port/types.js'
import type { StorageExecuteResult, StorageLimits, StorageRow, StorageSqlValue, StorageStatement } from './types.js'

const ARRAY_IS_ARRAY = Array.isArray
const ARRAY_PROTOTYPE = Array.prototype
const ARRAY_BUFFER_PROTOTYPE = ArrayBuffer.prototype
const UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype
const GET_PROTOTYPE_OF = Object.getPrototypeOf
const GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor
const TYPED_ARRAY_PROTOTYPE = GET_PROTOTYPE_OF(UINT8_ARRAY_PROTOTYPE)
const TYPED_BUFFER = GET_OWN_PROPERTY_DESCRIPTOR(TYPED_ARRAY_PROTOTYPE, 'buffer')?.get as () => unknown
const TYPED_BYTE_LENGTH = GET_OWN_PROPERTY_DESCRIPTOR(TYPED_ARRAY_PROTOTYPE, 'byteLength')?.get as () => unknown
const BUFFER_BYTE_LENGTH = GET_OWN_PROPERTY_DESCRIPTOR(ARRAY_BUFFER_PROTOTYPE, 'byteLength')?.get as () => unknown
const BUFFER_RESIZABLE = GET_OWN_PROPERTY_DESCRIPTOR(ARRAY_BUFFER_PROTOTYPE, 'resizable')?.get as
  | (() => unknown)
  | undefined
const BUFFER_MAX = GET_OWN_PROPERTY_DESCRIPTOR(ARRAY_BUFFER_PROTOTYPE, 'maxByteLength')?.get as
  | (() => unknown)
  | undefined
const BUFFER_DETACHED = GET_OWN_PROPERTY_DESCRIPTOR(ARRAY_BUFFER_PROTOTYPE, 'detached')?.get as
  | (() => unknown)
  | undefined
const CALL = Function.prototype.call
const UINT8_SLICE = UINT8_ARRAY_PROTOTYPE.slice
const BUFFER_SLICE = ARRAY_BUFFER_PROTOTYPE.slice
const FREEZE = Object.freeze
const typedBuffer = (value: Uint8Array) => CALL.call(TYPED_BUFFER, value) as ArrayBuffer
const typedByteLength = (value: Uint8Array) => CALL.call(TYPED_BYTE_LENGTH, value) as number
const bufferByteLength = (value: ArrayBuffer) => CALL.call(BUFFER_BYTE_LENGTH, value) as number
const bufferFlag = (getter: (() => unknown) | undefined, value: ArrayBuffer) =>
  getter == null ? undefined : CALL.call(getter, value)
const copyTyped = (value: Uint8Array) => CALL.call(UINT8_SLICE, value) as Uint8Array
const copyBuffer = (value: ArrayBuffer) => new Uint8Array(CALL.call(BUFFER_SLICE, value) as ArrayBuffer)

export const storageByteLength = (value: string) => utf8ByteLength(value)

const validBuffer = (buffer: ArrayBuffer, maximum: number) => {
  const length = bufferByteLength(buffer)
  if (
    length > maximum || bufferFlag(BUFFER_DETACHED, buffer) === true || bufferFlag(BUFFER_RESIZABLE, buffer) === true
  ) return false
  const max = bufferFlag(BUFFER_MAX, buffer)
  return typeof max !== 'number' || max === length
}

/** Captured internal-slot access rejects Proxy, SAB, resizable and detached inputs before copy allocation. */
export const copyStorageBinary = (value: Uint8Array | ArrayBuffer, maximum: number) => {
  try {
    if (value != null && typeof value === 'object' && GET_PROTOTYPE_OF(value) === ARRAY_BUFFER_PROTOTYPE) {
      const buffer = value as ArrayBuffer
      return validBuffer(buffer, maximum) ? copyBuffer(buffer) : undefined
    }
    if (value == null || typeof value !== 'object' || GET_PROTOTYPE_OF(value) !== UINT8_ARRAY_PROTOTYPE) {
      return undefined
    }
    const typed = value as Uint8Array
    const buffer = typedBuffer(typed)
    if (!validBuffer(buffer, maximum) || typedByteLength(typed) > maximum) return undefined
    return copyTyped(typed)
  } catch {
    return undefined
  }
}

export const closeStorageResources = (resources: readonly NativeResourceHandle[] | undefined, reason: string) => {
  for (const resource of resources ?? []) {
    try {
      resource.close(reason)
    } catch {}
  }
}
export const validateStorageKey = (value: unknown, limits: Readonly<StorageLimits>, allowEmpty = false) => {
  if (
    typeof value !== 'string' || (!allowEmpty && storageByteLength(value) === 0) ||
    storageByteLength(value) > limits.maxKeyBytes
  ) throw createStorageError('storage.invalid_argument')
  return value
}
export const validateStorageDatabase = (value: unknown, limits: Readonly<StorageLimits>) => {
  if (
    typeof value !== 'string' || storageByteLength(value) === 0 ||
    storageByteLength(value) > limits.maxDatabaseNameBytes
  ) throw createStorageError('storage.invalid_argument')
  return value
}
const strictArray = (value: unknown, maximum: number) => {
  if (!ARRAY_IS_ARRAY(value) || GET_PROTOTYPE_OF(value) !== ARRAY_PROTOTYPE) throw new Error('not genuine array')
  const length = GET_OWN_PROPERTY_DESCRIPTOR(value, 'length')
  if (length == null || !('value' in length) || typeof length.value !== 'number' || length.value > maximum) {
    throw new Error('invalid length')
  }
  return length.value
}
export const assertStorageVoidResult = (output: NativeResult, value: unknown) => {
  if (value !== null || output.binary?.length || output.resources?.length) {
    closeStorageResources(output.resources, 'malformed_storage_result')
    throw createStorageError('storage.protocol_error')
  }
}
export const parseStorageExecuteResult = (output: NativeResult, value: unknown): StorageExecuteResult => {
  try {
    if (
      value == null || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || output.binary?.length ||
      output.resources?.length
    ) throw new Error('invalid result')
    const item = GET_OWN_PROPERTY_DESCRIPTOR(value, 'changes')
    if (
      item == null || !item.enumerable || !('value' in item) || typeof item.value !== 'number' ||
      !Number.isSafeInteger(item.value) || item.value < 0
    ) throw new Error('invalid changes')
    return FREEZE({ changes: item.value })
  } catch {
    closeStorageResources(output.resources, 'malformed_storage_result')
    throw createStorageError('storage.protocol_error')
  }
}
export const validateStorageStatement = (value: unknown, limits: Readonly<StorageLimits>): StorageStatement => {
  try {
    if (
      value == null || typeof value !== 'object' || ARRAY_IS_ARRAY(value) ||
      GET_PROTOTYPE_OF(value) !== Object.prototype
    ) throw new Error('invalid statement')
    const sql = GET_OWN_PROPERTY_DESCRIPTOR(value, 'sql')
    const params = GET_OWN_PROPERTY_DESCRIPTOR(value, 'params')
    if (
      sql == null || !sql.enumerable || !('value' in sql) || typeof sql.value !== 'string' ||
      storageByteLength(sql.value) === 0 || storageByteLength(sql.value) > limits.maxSqlBytes
    ) throw new Error('invalid sql')
    if (params == null) return FREEZE({ sql: sql.value })
    if (!params.enumerable || !('value' in params)) throw new Error('invalid params')
    const length = strictArray(params.value, limits.maxTransactionStatements)
    const copied: StorageSqlValue[] = []
    for (let index = 0; index < length; index += 1) {
      const item = GET_OWN_PROPERTY_DESCRIPTOR(params.value, String(index))
      if (
        item == null || !item.enumerable || !('value' in item) ||
        (item.value !== null && typeof item.value !== 'boolean' && typeof item.value !== 'number' &&
          typeof item.value !== 'string')
      ) throw new Error('invalid parameter')
      copied.push(item.value)
    }
    return FREEZE({ params: FREEZE(copied), sql: sql.value })
  } catch {
    throw createStorageError('storage.invalid_argument')
  }
}
export const validateStorageStatements = (value: unknown, limits: Readonly<StorageLimits>) => {
  try {
    const length = strictArray(value, limits.maxTransactionStatements)
    if (length === 0) throw new Error('empty transaction')
    const copied: StorageStatement[] = []
    for (let index = 0; index < length; index += 1) {
      const item = GET_OWN_PROPERTY_DESCRIPTOR(value, String(index))
      if (item == null || !item.enumerable || !('value' in item)) throw new Error('sparse transaction')
      copied.push(validateStorageStatement(item.value, limits))
    }
    return FREEZE(copied)
  } catch {
    throw createStorageError('storage.invalid_argument')
  }
}
export const parseStorageRow = (value: unknown, limits: Readonly<StorageLimits>): StorageRow => {
  try {
    const length = strictArray(value, limits.maxKeysPerList)
    const row = Object.create(null) as Record<string, StorageSqlValue>
    for (let index = 0; index < length; index += 1) {
      const pair = GET_OWN_PROPERTY_DESCRIPTOR(value, String(index))?.value
      if (
        !ARRAY_IS_ARRAY(pair) || strictArray(pair, 2) !== 2 || typeof pair[0] !== 'string' ||
        Object.hasOwn(row, pair[0]) || storageByteLength(pair[0]) === 0 ||
        storageByteLength(pair[0]) > limits.maxKeyBytes
      ) throw new Error('invalid column')
      const cell = pair[1]
      if (cell !== null && typeof cell !== 'boolean' && typeof cell !== 'number' && typeof cell !== 'string') {
        throw new Error('invalid cell')
      }
      Object.defineProperty(row, pair[0], { configurable: false, enumerable: true, value: cell, writable: false })
    }
    return FREEZE(row)
  } catch {
    throw createStorageError('storage.protocol_error')
  }
}
