/* eslint-disable max-lines -- strict event/resource shape parsing stays at one provider boundary. */

import { cloneJsonValue, preflightBinary } from './value-validation.js'

import type {
  NativeBridgeLimits,
  NativeJsonValue,
  NativePortErrorCode,
  NativePortErrorData,
  NativePortErrorDetails,
  NativePortErrorDomain,
  NativePortResourceGrant,
  NativeProviderToken
} from './types.js'
import type { BinaryPlan } from './value-validation.js'

export interface PreparedNativeOutput {
  binaryPlan: BinaryPlan
  resources: readonly NativePortResourceGrant[]
  value?: NativeJsonValue
}

export type PreparedNativePortEvent =
  | { error: Readonly<NativePortErrorData>; type: 'error' }
  | { output: PreparedNativeOutput; type: 'end' }
  | { output: PreparedNativeOutput; type: 'result' }
  | { output: PreparedNativeOutput; sequence: number; type: 'chunk' }

export type NativePortEventPreflight =
  | { event: PreparedNativePortEvent; ok: true }
  | { code: 'limit_exceeded' | 'protocol_error'; ok: false }

/**
 * A bounded, descriptor-only scan used to release grants from malformed
 * provider events. `grants` contains only items proven safe before failure.
 */
export interface UndeliveredResourceGrantExtraction {
  code?: 'limit_exceeded' | 'protocol_error'
  grants: readonly NativePortResourceGrant[]
  hasDuplicate: boolean
}

interface EventHeader {
  record: object
  type: string
}

const RUNTIME_ERROR_CODES = new Set<NativePortErrorCode>([
  'cancelled',
  'capability_unsupported',
  'disposed',
  'internal',
  'invalid_request',
  'invalid_value',
  'limit_exceeded',
  'operation_unsupported',
  'protocol_error',
  'resource_invalid',
  'timeout'
])
const FS_ERROR_CODES = new Set<NativePortErrorCode>([
  'exists',
  'not_found',
  'permission_denied'
])
const NETWORK_ERROR_CODES = new Set<NativePortErrorCode>([
  'connection_refused',
  'timeout',
  'unavailable'
])
const ERROR_CODES_BY_DOMAIN: Readonly<Record<NativePortErrorDomain, ReadonlySet<NativePortErrorCode>>> = {
  fs: FS_ERROR_CODES,
  network: NETWORK_ERROR_CODES,
  runtime: RUNTIME_ERROR_CODES
}
const ERROR_DETAIL_RESOURCES = new Set(['directory', 'file', 'host', 'socket'])
const RESOURCE_TYPE_PATTERN = /^[\w@][\w@./:-]{0,127}$/u
const PROVIDER_TOKEN_PATTERN = /^[\w@][\w@./:-]{0,127}$/u
const ownDataDescriptor = (value: object, key: string) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor != null && descriptor.enumerable && 'value' in descriptor
    ? descriptor
    : undefined
}

const ownData = (value: object, key: string) => ownDataDescriptor(value, key)?.value

const readOptionalData = (value: object, key: string) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return { present: false as const }
  if (!descriptor.enumerable || !('value' in descriptor)) {
    return { invalid: true as const, present: true as const }
  }
  return { present: true as const, value: descriptor.value }
}

/**
 * v1 deliberately ignores unknown provider keys. Inspecting them would require
 * an own-key enumeration and lets a Proxy force an unbounded allocation.
 */
const hasKnownDataKeys = (
  record: object,
  required: readonly string[],
  optional: readonly string[] = []
) => {
  if (required.some(key => ownDataDescriptor(record, key) == null)) return false
  return optional.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    return descriptor === undefined || ownDataDescriptor(record, key) != null
  })
}

const readHeader = (
  event: unknown,
  expectedId: string
): EventHeader | undefined => {
  if (event == null || typeof event !== 'object' || Array.isArray(event)) {
    return undefined
  }
  const prototype = Object.getPrototypeOf(event)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const id = ownData(event, 'id')
  const type = ownData(event, 'type')
  if (id !== expectedId || typeof type !== 'string') return undefined
  return { record: event, type }
}

const extractResourceGrants = (
  value: unknown,
  limits: NativeBridgeLimits
): UndeliveredResourceGrantExtraction => {
  const resources: NativePortResourceGrant[] = []
  const seenTokens = new Set<NativeProviderToken>()
  let hasDuplicate = false
  const finish = (code?: 'limit_exceeded' | 'protocol_error') =>
    Object.freeze({
      ...(code === undefined ? {} : { code }),
      grants: Object.freeze(resources),
      hasDuplicate
    })
  try {
    if (value === undefined) return finish()
    if (!Array.isArray(value)) return finish('protocol_error')
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (lengthDescriptor == null || !('value' in lengthDescriptor)) {
      return finish('protocol_error')
    }
    const length = lengthDescriptor.value
    if (!Number.isSafeInteger(length) || (length as number) < 0) {
      return finish('protocol_error')
    }
    if (
      (length as number) > limits.maxOpenResources ||
      (length as number) > limits.maxHandles
    ) {
      return finish('limit_exceeded')
    }
    for (let index = 0; index < (length as number); index += 1) {
      const itemDescriptor = ownDataDescriptor(value, String(index))
      const item = itemDescriptor?.value
      if (item == null || typeof item !== 'object' || Array.isArray(item)) {
        return finish('protocol_error')
      }
      const prototype = Object.getPrototypeOf(item)
      const providerToken = ownData(item, 'providerToken')
      const type = ownData(item, 'type')
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        !hasKnownDataKeys(
          item,
          ['providerToken', 'type']
        ) ||
        typeof providerToken !== 'string' ||
        !PROVIDER_TOKEN_PATTERN.test(providerToken) ||
        typeof type !== 'string' ||
        !RESOURCE_TYPE_PATTERN.test(type)
      ) {
        return finish('protocol_error')
      }
      const token = providerToken as NativeProviderToken
      hasDuplicate ||= seenTokens.has(token)
      seenTokens.add(token)
      resources.push(Object.freeze({ providerToken: token, type }))
    }
    return finish()
  } catch {
    return finish('protocol_error')
  }
}

export const extractUndeliveredResourceGrants = (
  event: unknown,
  limits: NativeBridgeLimits
): UndeliveredResourceGrantExtraction => {
  const protocolFailure = () =>
    Object.freeze({
      code: 'protocol_error' as const,
      grants: Object.freeze([]),
      hasDuplicate: false
    })
  try {
    if (event == null || typeof event !== 'object' || Array.isArray(event)) {
      return protocolFailure()
    }
    const descriptor = Object.getOwnPropertyDescriptor(event, 'resources')
    if (descriptor === undefined) return extractResourceGrants(undefined, limits)
    if (!descriptor.enumerable || !('value' in descriptor)) {
      return protocolFailure()
    }
    return extractResourceGrants(descriptor.value, limits)
  } catch {
    return protocolFailure()
  }
}

const readResources = (
  value: unknown,
  limits: NativeBridgeLimits
):
  | { ok: true; resources: readonly NativePortResourceGrant[] }
  | { code: 'limit_exceeded' | 'protocol_error'; ok: false } =>
{
  const extraction = extractResourceGrants(value, limits)
  return extraction.code === undefined
    ? { ok: true, resources: extraction.grants }
    : { code: extraction.code, ok: false }
}

const readOutput = (
  header: EventHeader,
  limits: NativeBridgeLimits
):
  | { ok: true; output: PreparedNativeOutput }
  | { code: 'limit_exceeded' | 'protocol_error'; ok: false } =>
{
  const binary = readOptionalData(header.record, 'binary')
  const resources = readOptionalData(header.record, 'resources')
  const value = readOptionalData(header.record, 'value')
  if (binary.invalid || resources.invalid || value.invalid) {
    return { code: 'protocol_error', ok: false }
  }

  let clonedValue: NativeJsonValue | undefined
  if (value.present) {
    const cloned = cloneJsonValue(value.value, limits)
    if (!cloned.ok) {
      return {
        code: cloned.reason === 'limit_exceeded'
          ? 'limit_exceeded'
          : 'protocol_error',
        ok: false
      }
    }
    clonedValue = cloned.value
  }
  const binaryPlan = preflightBinary(binary.present ? binary.value : undefined, limits)
  if (!binaryPlan.ok) {
    return {
      code: binaryPlan.reason === 'limit_exceeded'
        ? 'limit_exceeded'
        : 'protocol_error',
      ok: false
    }
  }
  const resourceResult = readResources(
    resources.present ? resources.value : undefined,
    limits
  )
  if (!resourceResult.ok) return resourceResult
  return {
    ok: true,
    output: Object.freeze({
      binaryPlan: binaryPlan.plan,
      resources: resourceResult.resources,
      ...(clonedValue === undefined ? {} : { value: clonedValue })
    })
  }
}

const readError = (header: EventHeader): NativePortEventPreflight => {
  if (
    !hasKnownDataKeys(
      header.record,
      ['error', 'id', 'type'],
      ['resources']
    )
  ) {
    return { code: 'protocol_error', ok: false }
  }
  if (Object.getOwnPropertyDescriptor(header.record, 'resources') !== undefined) {
    return { code: 'protocol_error', ok: false }
  }
  const error = ownData(header.record, 'error')
  if (error == null || typeof error !== 'object' || Array.isArray(error)) {
    return { code: 'protocol_error', ok: false }
  }
  const prototype = Object.getPrototypeOf(error)
  if (Object.getOwnPropertyDescriptor(error, 'message') !== undefined) {
    return { code: 'protocol_error', ok: false }
  }
  const code = ownData(error, 'code')
  const domain = ownData(error, 'domain') ?? 'runtime'
  const validDomain = domain === 'fs' || domain === 'network' || domain === 'runtime'
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    !hasKnownDataKeys(
      error,
      ['code'],
      ['details', 'domain']
    ) ||
    typeof code !== 'string' ||
    !validDomain
  ) {
    return { code: 'protocol_error', ok: false }
  }
  const normalizedDomain = domain as NativePortErrorDomain
  if (!ERROR_CODES_BY_DOMAIN[normalizedDomain].has(code as NativePortErrorCode)) {
    return { code: 'protocol_error', ok: false }
  }
  const rawDetails = ownData(error, 'details')
  let details: Readonly<NativePortErrorDetails> | undefined
  if (rawDetails !== undefined) {
    if (
      rawDetails == null ||
      typeof rawDetails !== 'object' ||
      Array.isArray(rawDetails) ||
      (Object.getPrototypeOf(rawDetails) !== Object.prototype &&
        Object.getPrototypeOf(rawDetails) !== null)
    ) {
      return { code: 'protocol_error', ok: false }
    }
    const resource = ownData(rawDetails, 'resource')
    const retryable = ownData(rawDetails, 'retryable')
    if (
      !hasKnownDataKeys(
        rawDetails,
        [],
        ['resource', 'retryable']
      ) ||
      (resource !== undefined &&
        (typeof resource !== 'string' || !ERROR_DETAIL_RESOURCES.has(resource))) ||
      (retryable !== undefined && typeof retryable !== 'boolean')
    ) {
      return { code: 'protocol_error', ok: false }
    }
    details = Object.freeze({
      ...(resource === undefined
        ? {}
        : { resource: resource as NativePortErrorDetails['resource'] }),
      ...(retryable === undefined ? {} : { retryable })
    })
  }
  return {
    event: {
      error: Object.freeze({
        code: code as NativePortErrorCode,
        ...(details === undefined ? {} : { details }),
        domain: normalizedDomain
      }),
      type: 'error'
    },
    ok: true
  }
}

export const preflightNativePortEvent = (
  event: unknown,
  expectedId: string,
  limits: NativeBridgeLimits,
  acceptChunk: boolean
): NativePortEventPreflight => {
  try {
    const header = readHeader(event, expectedId)
    if (!header) return { code: 'protocol_error', ok: false }
    if (header.type === 'error') return readError(header)
    if (header.type === 'chunk') {
      if (!acceptChunk) {
        return { code: 'protocol_error', ok: false }
      }
      const sequence = ownData(header.record, 'sequence')
      if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) {
        return { code: 'protocol_error', ok: false }
      }
      const output = readOutput(
        header,
        limits
      )
      return output.ok
        ? {
          event: {
            output: output.output,
            sequence: sequence as number,
            type: 'chunk'
          },
          ok: true
        }
        : output
    }
    if (header.type !== 'result' && header.type !== 'end') {
      return { code: 'protocol_error', ok: false }
    }
    const output = readOutput(
      header,
      limits
    )
    return output.ok
      ? { event: { output: output.output, type: header.type }, ok: true }
      : output
  } catch {
    return { code: 'protocol_error', ok: false }
  }
}
