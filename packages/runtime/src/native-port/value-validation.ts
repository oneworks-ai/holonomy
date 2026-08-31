/* eslint-disable max-lines -- JSON/resource traversal and binary preflight share one hostile-value boundary. */

import { NativeBridgeError } from './errors.js'

import type {
  NativeBinary,
  NativeBridgeLimits,
  NativeJsonValue,
  NativePortArgumentValue,
  NativePortResourceReference
} from './types.js'

type CloneFailureReason =
  | 'invalid_value'
  | 'limit_exceeded'
  | 'resource_invalid'

export type JsonCloneResult<TValue = NativeJsonValue> =
  | { bytes: number; ok: true; value: TValue }
  | { ok: false; reason: CloneFailureReason }

interface BinaryPlanEntry {
  bytes: number
  handle: string
  kind: 'array-buffer' | 'uint8-array'
  source: ArrayBuffer | Uint8Array
}

export interface BinaryPlan {
  bytes: number
  entries: readonly BinaryPlanEntry[]
  handles: number
}

export type BinaryPreflightResult =
  | { ok: true; plan: BinaryPlan }
  | { ok: false; reason: 'invalid_value' | 'limit_exceeded' }

export type ResourceReferenceResolver = (
  value: object
) => NativePortResourceReference | undefined

const HANDLE_PATTERN = /^\w[\w.:-]{0,127}$/u
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/u

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength'
)?.get
const arrayBufferSlice = ArrayBuffer.prototype.slice
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength'
)?.get

const utf8ByteLength = (value: string) => {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

const encodedStringBytes = (value: string) => utf8ByteLength(JSON.stringify(value))

const cloneValue = <TValue extends NativeJsonValue | NativePortArgumentValue>(
  value: unknown,
  limits: Pick<NativeBridgeLimits, 'maxInlineBytes' | 'maxJsonDepth'>,
  resolveResource?: ResourceReferenceResolver
): JsonCloneResult<TValue> => {
  let bytes = 0
  let failure: CloneFailureReason = 'invalid_value'
  const active = new WeakSet<object>()

  const addBytes = (amount: number) => {
    bytes += amount
    if (!Number.isSafeInteger(bytes) || bytes > limits.maxInlineBytes) {
      failure = 'limit_exceeded'
      return false
    }
    return true
  }

  const visit = (
    current: unknown,
    depth: number
  ): NativeJsonValue | NativePortArgumentValue | undefined => {
    if (depth > limits.maxJsonDepth) return undefined
    if (current === null) return addBytes(4) ? null : undefined
    if (typeof current === 'boolean') {
      return addBytes(current ? 4 : 5) ? current : undefined
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return undefined
      return addBytes(utf8ByteLength(JSON.stringify(current))) ? current : undefined
    }
    if (typeof current === 'string') {
      return addBytes(encodedStringBytes(current)) ? current : undefined
    }
    if (typeof current !== 'object' || active.has(current)) return undefined

    if (resolveResource) {
      try {
        const reference = resolveResource(current)
        if (reference) {
          const referenceBytes = 13 + encodedStringBytes(reference.resource)
          return addBytes(referenceBytes) ? reference : undefined
        }
      } catch (error) {
        failure = error instanceof NativeBridgeError &&
            error.code === 'resource_invalid'
          ? 'resource_invalid'
          : 'invalid_value'
        return undefined
      }
    }

    const isArray = Array.isArray(current)
    const prototype = Object.getPrototypeOf(current)
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      return undefined
    }

    active.add(current)
    try {
      const keys = Reflect.ownKeys(current)
      if (keys.some(key => typeof key !== 'string')) return undefined

      if (isArray) {
        const length = Object.getOwnPropertyDescriptor(current, 'length')?.value
        if (
          !Number.isSafeInteger(length) ||
          (length as number) < 0 ||
          keys.some((key) => {
            if (key === 'length') return false
            if (!ARRAY_INDEX_PATTERN.test(key as string)) return true
            return Number(key) >= (length as number)
          }) ||
          keys.length !== (length as number) + 1 ||
          !addBytes(2 + Math.max(0, (length as number) - 1))
        ) {
          return undefined
        }
        const result: NativePortArgumentValue[] = []
        for (let index = 0; index < (length as number); index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
          if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
            return undefined
          }
          const child = visit(descriptor.value, depth + 1)
          if (child === undefined) return undefined
          result.push(child)
        }
        return result
      }

      if (!addBytes(2 + Math.max(0, keys.length - 1))) return undefined
      const result: Record<string, NativePortArgumentValue> = {}
      for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
          return undefined
        }
        if (!addBytes(encodedStringBytes(key) + 1)) return undefined
        const child = visit(descriptor.value, depth + 1)
        if (child === undefined) return undefined
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: child,
          writable: true
        })
      }
      return result
    } finally {
      active.delete(current)
    }
  }

  try {
    const cloned = visit(value, 0)
    return cloned === undefined
      ? { ok: false, reason: failure }
      : { bytes, ok: true, value: cloned as TValue }
  } catch {
    return { ok: false, reason: failure }
  }
}

export const cloneJsonValue = (
  value: unknown,
  limits: Pick<NativeBridgeLimits, 'maxInlineBytes' | 'maxJsonDepth'>
): JsonCloneResult => cloneValue(value, limits)

export const cloneNativeArgumentValue = (
  value: unknown,
  limits: Pick<NativeBridgeLimits, 'maxInlineBytes' | 'maxJsonDepth'>,
  resolveResource: ResourceReferenceResolver
): JsonCloneResult<NativePortArgumentValue> =>
  cloneValue(
    value,
    limits,
    resolveResource
  )

const readBinarySource = (
  value: unknown
): Omit<BinaryPlanEntry, 'handle'> | undefined => {
  if (
    value instanceof Uint8Array &&
    Object.getPrototypeOf(value) === Uint8Array.prototype &&
    typedArrayByteLength
  ) {
    const bytes = typedArrayByteLength.call(value) as number
    return { bytes, kind: 'uint8-array', source: value }
  }
  if (
    value instanceof ArrayBuffer &&
    Object.getPrototypeOf(value) === ArrayBuffer.prototype &&
    arrayBufferByteLength
  ) {
    const bytes = arrayBufferByteLength.call(value) as number
    return { bytes, kind: 'array-buffer', source: value }
  }
  return undefined
}

export const preflightBinary = (
  value: unknown,
  limits: Pick<NativeBridgeLimits, 'maxBinaryBytes' | 'maxBinaryHandles'>
): BinaryPreflightResult => {
  if (value === undefined) {
    return {
      ok: true,
      plan: { bytes: 0, entries: Object.freeze([]), handles: 0 }
    }
  }
  if (!Array.isArray(value)) {
    return { ok: false, reason: 'invalid_value' }
  }

  const entries: BinaryPlanEntry[] = []
  const seenHandles = new Set<string>()
  let bytes = 0
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (lengthDescriptor == null || !('value' in lengthDescriptor)) {
      return { ok: false, reason: 'invalid_value' }
    }
    const length = lengthDescriptor.value
    if (!Number.isSafeInteger(length) || (length as number) < 0) {
      return { ok: false, reason: 'invalid_value' }
    }
    if ((length as number) > limits.maxBinaryHandles) {
      return { ok: false, reason: 'limit_exceeded' }
    }
    const keys = Reflect.ownKeys(value)
    if (
      keys.length !== (length as number) + 1 ||
      keys.some((key) => {
        if (key === 'length') return false
        return typeof key !== 'string' || !ARRAY_INDEX_PATTERN.test(key) ||
          Number(key) >= (length as number)
      })
    ) {
      return {
        ok: false,
        reason: 'invalid_value'
      }
    }

    for (let index = 0; index < (length as number); index += 1) {
      const itemDescriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (
        itemDescriptor == null ||
        !itemDescriptor.enumerable ||
        !('value' in itemDescriptor)
      ) {
        return { ok: false, reason: 'invalid_value' }
      }
      const item = itemDescriptor.value
      if (item == null || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, reason: 'invalid_value' }
      }
      const prototype = Object.getPrototypeOf(item)
      const itemKeys = Reflect.ownKeys(item)
      const dataDescriptor = Object.getOwnPropertyDescriptor(item, 'data')
      const handleDescriptor = Object.getOwnPropertyDescriptor(item, 'handle')
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        itemKeys.length !== 2 ||
        !itemKeys.includes('data') ||
        !itemKeys.includes('handle') ||
        itemKeys.some(key => typeof key !== 'string') ||
        dataDescriptor == null ||
        !dataDescriptor.enumerable ||
        !('value' in dataDescriptor) ||
        handleDescriptor == null ||
        !handleDescriptor.enumerable ||
        !('value' in handleDescriptor)
      ) {
        return { ok: false, reason: 'invalid_value' }
      }
      const handle = handleDescriptor.value
      const source = readBinarySource(dataDescriptor.value)
      if (
        typeof handle !== 'string' ||
        !HANDLE_PATTERN.test(handle) ||
        seenHandles.has(handle) ||
        source == null
      ) {
        return { ok: false, reason: 'invalid_value' }
      }
      bytes += source.bytes
      if (!Number.isSafeInteger(bytes) || bytes > limits.maxBinaryBytes) {
        return { ok: false, reason: 'limit_exceeded' }
      }
      seenHandles.add(handle)
      entries.push({ ...source, handle })
    }
  } catch {
    return { ok: false, reason: 'invalid_value' }
  }

  return {
    ok: true,
    plan: Object.freeze({
      bytes,
      entries: Object.freeze(entries),
      handles: entries.length
    })
  }
}

export const copyBinary = (
  plan: BinaryPlan
): readonly NativeBinary<Uint8Array>[] | undefined => {
  if (plan.entries.length === 0) return undefined
  const binary = plan.entries.map((entry) => {
    const data = entry.kind === 'uint8-array'
      ? new Uint8Array(entry.source as Uint8Array)
      : new Uint8Array(arrayBufferSlice.call(entry.source as ArrayBuffer, 0))
    return Object.freeze({ data, handle: entry.handle })
  })
  return Object.freeze(binary)
}
