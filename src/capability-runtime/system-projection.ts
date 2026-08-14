import { invalidPolicy } from './errors.js'
import { SYSTEM_INFORMATION_FIELDS_V1 } from './registry-types.js'
import type { SystemInformationFieldV1 } from './registry-types.js'
import { normalizeSystemFieldValue } from './system-field-values.js'
import { coarseSystemFieldValue, redactSystemFieldValue } from './system-transform.js'
import type { HostSystemProjectionV1 } from './system-types.js'
import { deepFreeze, exact, literal, record, required } from './validation.js'

const normalizeField = (field: SystemInformationFieldV1, value: unknown): unknown => {
  const input = exact(value, ['mode', 'precision', 'value'])
  const mode = literal(required(input, 'mode'), ['real', 'redacted', 'synthetic', 'unavailable'] as const)
  if (mode === 'unavailable') {
    if (Object.keys(input).length !== 2 || required(input, 'precision') !== 'none') return invalidPolicy()
    return Object.freeze({ mode, precision: 'none' })
  }
  const normalized = normalizeSystemFieldValue(field, required(input, 'value'))
  if (mode === 'redacted') {
    if (required(input, 'precision') !== 'redacted') return invalidPolicy()
    return Object.freeze({ mode, precision: 'redacted', value: redactSystemFieldValue(field) })
  }
  const precision = literal(required(input, 'precision'), ['coarse', 'exact'] as const)
  return Object.freeze({
    mode,
    precision,
    value: precision === 'coarse' ? coarseSystemFieldValue(field, normalized) : normalized
  })
}

export const compileHostSystemProjectionV1 = (value: unknown): HostSystemProjectionV1 => {
  const input = exact(value, ['fields', 'schemaVersion'])
  if (required(input, 'schemaVersion') !== 1) return invalidPolicy()
  const fieldsInput = record(required(input, 'fields'))
  const fields = Object.create(null) as Record<string, unknown>
  for (const field of Object.keys(fieldsInput).sort()) {
    if (!SYSTEM_INFORMATION_FIELDS_V1.includes(field as SystemInformationFieldV1)) return invalidPolicy()
    fields[field] = normalizeField(field as SystemInformationFieldV1, fieldsInput[field])
  }
  return deepFreeze({ fields, schemaVersion: 1 }) as HostSystemProjectionV1
}

export const unavailableHostSystemProjectionV1 = (): HostSystemProjectionV1 =>
  Object.freeze({
    fields: Object.freeze({}),
    schemaVersion: 1
  })
