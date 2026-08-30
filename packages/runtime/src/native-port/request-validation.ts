/* eslint-disable max-lines -- request, authority, option and deadline snapshots form one admission boundary. */

import { NativeBridgeError, createNativeBridgeError } from './errors.js'
import { cloneNativeArgumentValue, copyBinary, preflightBinary } from './value-validation.js'

import type {
  NativeAuthority,
  NativeBridgeLimits,
  NativeCallOptions,
  NativePortArgumentValue,
  NativePortRequest,
  NativeRequest
} from './types.js'
import type { BinaryPlan, ResourceReferenceResolver } from './value-validation.js'

export const DEFAULT_NATIVE_BRIDGE_LIMITS: NativeBridgeLimits = {
  maxBinaryBytes: 8 * 1024 * 1024,
  maxBinaryHandles: 128,
  maxCreditsPerStream: 16,
  maxHandles: 512,
  maxInFlightBinaryBytes: 32 * 1024 * 1024,
  maxInFlightBinaryHandles: 512,
  maxInlineBytes: 1024 * 1024,
  maxJsonDepth: 64,
  maxOpenResources: 128,
  maxOutstandingCredits: 256,
  maxPendingRequests: 64,
  maxTimeoutMs: 5 * 60 * 1000
}

export interface PreparedNativeCallOptions {
  abortSignal?: PreparedAbortSignal
  signalAborted: boolean
  timeoutMs?: number
}

export interface PreparedAbortSignal {
  add(listener: () => void): void
  readAborted(): boolean
  remove(listener: () => void): void
}

export interface PreparedNativeRequest {
  args: NativePortArgumentValue
  binaryPlan: BinaryPlan
  deadlineMs?: number
  id: string
  module: string
  operation: string
}

const REQUEST_KEYS = new Set([
  'args',
  'binary',
  'deadlineMs',
  'id',
  'module',
  'operation'
])
const CALL_OPTION_KEYS = new Set(['signal', 'timeoutMs'])
const LIMIT_KEYS = new Set(Object.keys(DEFAULT_NATIVE_BRIDGE_LIMITS))
const ID_PATTERN = /^\w[\w.:-]{0,127}$/u
const NAME_PATTERN = /^[\w@][\w@./:-]{0,127}$/u
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/u

const ownDataDescriptor = (value: object, key: string) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor != null && descriptor.enumerable && 'value' in descriptor
    ? descriptor
    : undefined
}

const ownData = (value: object, key: string) => ownDataDescriptor(value, key)?.value

const readStrictRecord = (
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[]
): object => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw createNativeBridgeError('invalid_request')
  }
  const prototype = Object.getPrototypeOf(value)
  const keys = Reflect.ownKeys(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.some(
      key =>
        typeof key !== 'string' ||
        !allowedKeys.has(key) ||
        ownDataDescriptor(value, key) == null
    ) ||
    requiredKeys.some(key => ownDataDescriptor(value, key) == null)
  ) {
    throw createNativeBridgeError('invalid_request')
  }
  return value
}

const readStrictArray = (
  value: unknown,
  maxLength: number
): readonly unknown[] => {
  if (!Array.isArray(value)) throw createNativeBridgeError('invalid_request')
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (lengthDescriptor == null || !('value' in lengthDescriptor)) {
    throw createNativeBridgeError('invalid_request')
  }
  const length = lengthDescriptor.value
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    throw createNativeBridgeError('invalid_request')
  }
  if ((length as number) > maxLength) {
    throw createNativeBridgeError('limit_exceeded')
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== (length as number) + 1 ||
    keys.some((key) => {
      if (key === 'length') return false
      if (typeof key !== 'string' || !ARRAY_INDEX_PATTERN.test(key)) return true
      const descriptor = ownDataDescriptor(value, key)
      return Number(key) >= (length as number) || descriptor == null
    })
  ) {
    throw createNativeBridgeError('invalid_request')
  }
  const snapshot: unknown[] = []
  for (let index = 0; index < (length as number); index += 1) {
    snapshot.push(ownData(value, String(index)))
  }
  return snapshot
}

const readPositiveInteger = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : undefined

const readNonNegativeInteger = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined

export const resolveNativeBridgeLimits = (
  overrides: Partial<NativeBridgeLimits> | undefined
): NativeBridgeLimits => {
  try {
    const resolved = { ...DEFAULT_NATIVE_BRIDGE_LIMITS }
    if (overrides !== undefined) {
      const record = readStrictRecord(overrides, LIMIT_KEYS, [])
      for (const key of Reflect.ownKeys(record) as string[]) {
        const value = ownData(record, key)
        const parsed = key === 'maxJsonDepth'
          ? readNonNegativeInteger(value)
          : readPositiveInteger(value)
        if (parsed == null) throw createNativeBridgeError('invalid_request')
        resolved[key as keyof NativeBridgeLimits] = parsed
      }
    }
    if (
      resolved.maxBinaryBytes > resolved.maxInFlightBinaryBytes ||
      resolved.maxBinaryHandles > resolved.maxInFlightBinaryHandles ||
      resolved.maxCreditsPerStream > resolved.maxOutstandingCredits
    ) {
      throw createNativeBridgeError('invalid_request')
    }
    return Object.freeze(resolved)
  } catch (error) {
    throw error instanceof NativeBridgeError
      ? error
      : createNativeBridgeError('invalid_request')
  }
}

export const resolveNativeAuthority = (
  authority: NativeAuthority
): Readonly<NativeAuthority> => {
  try {
    const record = readStrictRecord(
      authority,
      new Set(['capabilities', 'principal']),
      ['capabilities', 'principal']
    )
    const principal = ownData(record, 'principal')
    const rawCapabilities = readStrictArray(ownData(record, 'capabilities'), 256)
    if (
      typeof principal !== 'string' ||
      !ID_PATTERN.test(principal) ||
      rawCapabilities.some(
        capability => typeof capability !== 'string' || !NAME_PATTERN.test(capability)
      ) ||
      new Set(rawCapabilities).size !== rawCapabilities.length
    ) {
      throw createNativeBridgeError('invalid_request')
    }
    return Object.freeze({
      capabilities: Object.freeze(rawCapabilities as string[]),
      principal
    })
  } catch (error) {
    throw error instanceof NativeBridgeError
      ? error
      : createNativeBridgeError('invalid_request')
  }
}

const readGlobalDataConstructor = (name: 'AbortSignal' | 'EventTarget') => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  return descriptor != null && 'value' in descriptor &&
      typeof descriptor.value === 'function'
    ? descriptor.value as { prototype: object }
    : undefined
}

const prepareAbortSignal = (signal: unknown): PreparedAbortSignal => {
  const abortSignal = readGlobalDataConstructor('AbortSignal')
  const eventTarget = readGlobalDataConstructor('EventTarget')
  if (!abortSignal || !eventTarget || signal == null || typeof signal !== 'object') {
    throw createNativeBridgeError('invalid_request')
  }
  const abortGetter = Object.getOwnPropertyDescriptor(
    abortSignal.prototype,
    'aborted'
  )?.get
  const addEventListener = Object.getOwnPropertyDescriptor(
    eventTarget.prototype,
    'addEventListener'
  )?.value
  const removeEventListener = Object.getOwnPropertyDescriptor(
    eventTarget.prototype,
    'removeEventListener'
  )?.value
  if (
    typeof abortGetter !== 'function' ||
    typeof addEventListener !== 'function' ||
    typeof removeEventListener !== 'function'
  ) {
    throw createNativeBridgeError('invalid_request')
  }
  const readAborted = () => {
    try {
      const aborted = abortGetter.call(signal)
      if (typeof aborted !== 'boolean') throw createNativeBridgeError('invalid_request')
      return aborted
    } catch {
      throw createNativeBridgeError('invalid_request')
    }
  }
  return Object.freeze({
    add(listener: () => void) {
      addEventListener.call(signal, 'abort', listener, { once: true })
    },
    readAborted,
    remove(listener: () => void) {
      removeEventListener.call(signal, 'abort', listener)
    }
  })
}

export const prepareNativeCallOptions = (
  options: NativeCallOptions | undefined
): PreparedNativeCallOptions => {
  try {
    if (options === undefined) return { signalAborted: false }
    const record = readStrictRecord(options, CALL_OPTION_KEYS, [])
    const timeoutMs = ownData(record, 'timeoutMs')
    const signal = ownData(record, 'signal')
    if (
      timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0)
    ) {
      throw createNativeBridgeError('invalid_request')
    }
    const abortSignal = signal === undefined ? undefined : prepareAbortSignal(signal)
    return {
      ...(abortSignal === undefined ? {} : { abortSignal }),
      signalAborted: abortSignal?.readAborted() ?? false,
      ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number })
    }
  } catch (error) {
    throw error instanceof NativeBridgeError
      ? error
      : createNativeBridgeError('invalid_request')
  }
}

const resolveDeadline = (
  rawDeadline: unknown,
  timeoutMs: number | undefined,
  limits: NativeBridgeLimits,
  readNow: () => number
): number | undefined => {
  if (
    rawDeadline !== undefined &&
    (
      !Number.isFinite(rawDeadline) ||
      (rawDeadline as number) < 0 ||
      (rawDeadline as number) > Number.MAX_SAFE_INTEGER
    )
  ) {
    throw createNativeBridgeError('invalid_request')
  }
  if (rawDeadline === undefined && timeoutMs === undefined) return undefined

  const now = readNow()
  if (!Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER) {
    throw createNativeBridgeError('internal')
  }
  let deadline = rawDeadline as number | undefined
  if (timeoutMs !== undefined) {
    if (timeoutMs > limits.maxTimeoutMs) {
      throw createNativeBridgeError('limit_exceeded')
    }
    const timeoutDeadline = now + timeoutMs
    if (!Number.isSafeInteger(timeoutDeadline)) {
      throw createNativeBridgeError('limit_exceeded')
    }
    deadline = deadline === undefined
      ? timeoutDeadline
      : Math.min(deadline, timeoutDeadline)
  }
  if (
    deadline === undefined ||
    deadline - now > limits.maxTimeoutMs
  ) {
    throw createNativeBridgeError('limit_exceeded')
  }
  if (deadline <= now) throw createNativeBridgeError('timeout')
  return deadline
}

export const prepareNativeRequest = (
  request: NativeRequest,
  callOptions: PreparedNativeCallOptions,
  limits: NativeBridgeLimits,
  readNow: () => number,
  resolveResource: ResourceReferenceResolver
): PreparedNativeRequest => {
  try {
    const record = readStrictRecord(
      request,
      REQUEST_KEYS,
      ['args', 'id', 'module', 'operation']
    )
    const id = ownData(record, 'id')
    const module = ownData(record, 'module')
    const operation = ownData(record, 'operation')
    if (
      typeof id !== 'string' ||
      !ID_PATTERN.test(id) ||
      typeof module !== 'string' ||
      !NAME_PATTERN.test(module) ||
      typeof operation !== 'string' ||
      !NAME_PATTERN.test(operation)
    ) {
      throw createNativeBridgeError('invalid_request')
    }

    const args = cloneNativeArgumentValue(
      ownData(record, 'args'),
      limits,
      resolveResource
    )
    if (!args.ok) throw createNativeBridgeError(args.reason)
    const binaryPlan = preflightBinary(ownData(record, 'binary'), limits)
    if (!binaryPlan.ok) throw createNativeBridgeError(binaryPlan.reason)
    const deadlineMs = resolveDeadline(
      ownData(record, 'deadlineMs'),
      callOptions.timeoutMs,
      limits,
      readNow
    )
    if (callOptions.signalAborted) throw createNativeBridgeError('cancelled')

    return {
      args: args.value,
      binaryPlan: binaryPlan.plan,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      id,
      module,
      operation
    }
  } catch (error) {
    throw error instanceof NativeBridgeError
      ? error
      : createNativeBridgeError('invalid_request')
  }
}

export const materializeNativePortRequest = (
  prepared: PreparedNativeRequest
): NativePortRequest => {
  const binary = copyBinary(prepared.binaryPlan)
  return Object.freeze({
    args: prepared.args,
    ...(binary === undefined ? {} : { binary }),
    ...(prepared.deadlineMs === undefined ? {} : {
      deadlineMs: prepared.deadlineMs
    }),
    id: prepared.id,
    module: prepared.module,
    operation: prepared.operation
  })
}
