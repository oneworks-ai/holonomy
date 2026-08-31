import { invalidPolicy } from '@holonomyjs/runtime/kernel/errors'
import {
  DEVICE_OPERATIONS_V1,
  DEVICE_OPERATION_PRIVACY_TIER_V1,
  OBSERVER_EVENTS_V1,
  SYSTEM_INFORMATION_FIELDS_V1
} from '@holonomyjs/runtime/kernel/registry-types'
import { exact, integer, literal, record, required, stringSet } from '@holonomyjs/runtime/kernel/validation'
import type { DeviceSandboxV2, DiagnosticsSandboxV2, SystemInformationSandboxV2 } from './policy-host-types.js'

export const normalizeSystemSandbox = (value: unknown): SystemInformationSandboxV2 => {
  const input = exact(value, ['defaultMode', 'fields'])
  if (required(input, 'defaultMode') !== 'unavailable') return invalidPolicy()
  const fieldsInput = record(required(input, 'fields'))
  const fields: Record<string, unknown> = {}
  for (const key of Object.keys(fieldsInput).sort()) {
    if (!SYSTEM_INFORMATION_FIELDS_V1.includes(key as never)) return invalidPolicy()
    const ceiling = exact(fieldsInput[key], ['allowedModes', 'maxPrecision'])
    const allowedModes = stringSet(
      required(ceiling, 'allowedModes'),
      ['real', 'redacted', 'synthetic'] as const,
      1,
      3
    )
    fields[key] = Object.freeze({
      allowedModes,
      ...(Object.hasOwn(ceiling, 'maxPrecision')
        ? { maxPrecision: literal(ceiling.maxPrecision, ['coarse', 'exact', 'redacted'] as const) }
        : {})
    })
  }
  return Object.freeze({ defaultMode: 'unavailable', fields: Object.freeze(fields) })
}

export const normalizeDeviceSandbox = (value: unknown): DeviceSandboxV2 => {
  const input = exact(value, [
    'defaultAccess',
    'maxEventsPerSecond',
    'maxQueuedEvents',
    'maxSubscriptions',
    'operations'
  ])
  if (required(input, 'defaultAccess') !== 'deny') return invalidPolicy()
  const operationsInput = record(required(input, 'operations'))
  const operations: Record<string, unknown> = {}
  for (const key of Object.keys(operationsInput).sort()) {
    if (!DEVICE_OPERATIONS_V1.includes(key as never)) return invalidPolicy()
    const ceiling = exact(operationsInput[key], ['access', 'maxPrecision', 'maxPrivacyTier'])
    if (required(ceiling, 'access') !== 'allow') return invalidPolicy()
    const maxPrivacyTier = integer(required(ceiling, 'maxPrivacyTier'), 0, 3) as 0 | 1 | 2 | 3
    if (maxPrivacyTier < DEVICE_OPERATION_PRIVACY_TIER_V1[key as keyof typeof DEVICE_OPERATION_PRIVACY_TIER_V1]) {
      return invalidPolicy()
    }
    operations[key] = Object.freeze({
      access: 'allow',
      maxPrecision: literal(required(ceiling, 'maxPrecision'), ['coarse', 'exact', 'standard'] as const),
      maxPrivacyTier
    })
  }
  return Object.freeze({
    defaultAccess: 'deny',
    maxEventsPerSecond: integer(required(input, 'maxEventsPerSecond'), 1, 1000),
    maxQueuedEvents: integer(required(input, 'maxQueuedEvents'), 0, 4096),
    maxSubscriptions: integer(required(input, 'maxSubscriptions'), 0, 256),
    operations: Object.freeze(operations)
  }) as DeviceSandboxV2
}

export const normalizeDiagnosticsSandbox = (value: unknown): DiagnosticsSandboxV2 => {
  const input = exact(value, [
    'maxObserverCallbackMs',
    'maxQueuedEvents',
    'maxSourceReadBytes',
    'observerEvents',
    'retentionMs',
    'sourceReader'
  ])
  const sourceReader = literal(
    required(input, 'sourceReader'),
    ['boundedSource', 'metadataOnly', 'none'] as const
  )
  const maxSourceReadBytes = integer(required(input, 'maxSourceReadBytes'), 0, 1024 * 1024)
  if ((sourceReader === 'boundedSource') !== (maxSourceReadBytes > 0)) return invalidPolicy()
  return Object.freeze({
    maxObserverCallbackMs: integer(required(input, 'maxObserverCallbackMs'), 1, 120_000),
    maxQueuedEvents: integer(required(input, 'maxQueuedEvents'), 0, 4096),
    maxSourceReadBytes,
    observerEvents: stringSet(
      required(input, 'observerEvents'),
      OBSERVER_EVENTS_V1,
      0,
      OBSERVER_EVENTS_V1.length
    ),
    retentionMs: integer(required(input, 'retentionMs'), 0, 86_400_000),
    sourceReader
  })
}
