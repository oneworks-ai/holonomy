import { invalidArgumentType } from './errors.js'
import { callIntrinsic, freeze } from './intrinsics.js'

const RuntimeArrayBuffer = ArrayBuffer
const RuntimeObject = Object
const RuntimeUint8Array = Uint8Array
const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER
const arrayBufferByteLengthGetter = RuntimeObject.getOwnPropertyDescriptor(
  RuntimeArrayBuffer.prototype,
  'byteLength'
)?.get
const arrayBufferResizableGetter = RuntimeObject.getOwnPropertyDescriptor(
  RuntimeArrayBuffer.prototype,
  'resizable'
)?.get
const typedArrayPrototype = callIntrinsic(RuntimeObject.getPrototypeOf, RuntimeObject, [
  RuntimeUint8Array.prototype
]) as object
const bufferGetter = callIntrinsic(RuntimeObject.getOwnPropertyDescriptor, RuntimeObject, [
  typedArrayPrototype,
  'buffer'
])?.get
const byteLengthGetter = callIntrinsic(RuntimeObject.getOwnPropertyDescriptor, RuntimeObject, [
  typedArrayPrototype,
  'byteLength'
])?.get
const byteOffsetGetter = callIntrinsic(RuntimeObject.getOwnPropertyDescriptor, RuntimeObject, [
  typedArrayPrototype,
  'byteOffset'
])?.get
const typedArrayTagGetter = callIntrinsic(RuntimeObject.getOwnPropertyDescriptor, RuntimeObject, [
  typedArrayPrototype,
  Symbol.toStringTag
])?.get
const uint8ArraySetIntrinsic = RuntimeUint8Array.prototype.set

if (
  arrayBufferByteLengthGetter === undefined ||
  bufferGetter === undefined ||
  byteLengthGetter === undefined ||
  byteOffsetGetter === undefined ||
  typedArrayTagGetter === undefined
) {
  throw new Error('Required mobile runtime binary intrinsics are unavailable')
}

export interface TypedArraySnapshot {
  readonly backingByteLength: number
  readonly bytes: Uint8Array
  readonly byteLength: number
  readonly kind: string
}

/** Reads only typed-array and ArrayBuffer internal slots; it never uses guest properties. */
export const inspectTypedArray = (value: unknown): TypedArraySnapshot => {
  try {
    const kind = callIntrinsic(typedArrayTagGetter, value) as string
    const backing = callIntrinsic(bufferGetter, value) as ArrayBufferLike
    const byteLength = callIntrinsic(byteLengthGetter, value) as number
    const byteOffset = callIntrinsic(byteOffsetGetter, value) as number
    const backingByteLength = callIntrinsic(arrayBufferByteLengthGetter, backing) as number
    if (
      arrayBufferResizableGetter !== undefined &&
      callIntrinsic(arrayBufferResizableGetter, backing) === true
    ) {
      return invalidArgumentType()
    }
    const bytes = new RuntimeUint8Array(backing, byteOffset, byteLength)
    if (byteOffset + byteLength > backingByteLength) return invalidArgumentType()
    return freeze({ backingByteLength, byteLength, bytes, kind })
  } catch {
    return invalidArgumentType()
  }
}

export const inspectBytes = (value: unknown): TypedArraySnapshot => {
  const snapshot = inspectTypedArray(value)
  if (snapshot.kind !== 'Uint8Array') return invalidArgumentType()
  return snapshot
}

export const copyInspectedBytes = (snapshot: TypedArraySnapshot): Uint8Array => {
  const output = new RuntimeUint8Array(snapshot.byteLength)
  callIntrinsic(uint8ArraySetIntrinsic, output, [snapshot.bytes])
  return output
}

export const copyBytes = (value: unknown): Uint8Array => copyInspectedBytes(inspectBytes(value))

export const copyByteArray = (value: Uint8Array): Uint8Array => copyInspectedBytes(inspectBytes(value))

export const writeBytes = (target: Uint8Array, source: Uint8Array): void => {
  callIntrinsic(uint8ArraySetIntrinsic, target, [source])
}

export const zeroBytes = (value: unknown, maximumBytes = MAX_SAFE_BYTES): void => {
  if (value === undefined) return
  try {
    const snapshot = inspectBytes(value)
    if (snapshot.byteLength > maximumBytes) return
    for (let index = 0; index < snapshot.byteLength; index += 1) snapshot.bytes[index] = 0
  } catch {
    // Best effort only: rejected/detached/resizable backing stores are not touched.
  }
}

export const isIntegerTypedArrayKind = (kind: string): boolean => {
  switch (kind) {
    case 'BigInt64Array':
    case 'BigUint64Array':
    case 'Int16Array':
    case 'Int32Array':
    case 'Int8Array':
    case 'Uint16Array':
    case 'Uint32Array':
    case 'Uint8Array':
    case 'Uint8ClampedArray':
      return true
    default:
      return false
  }
}
