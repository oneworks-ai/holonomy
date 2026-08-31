import {
  DEVICE_OPERATIONS_V1,
  OBSERVER_EVENTS_V1,
  SYSTEM_INFORMATION_FIELDS_V1
} from '@holonomyjs/runtime/kernel/registry-types'
import { integerSchema, strictObject, stringSetSchema } from '@holonomyjs/runtime/kernel/schema-primitives'

const systemCeiling = strictObject({
  allowedModes: stringSetSchema({ enum: ['real', 'redacted', 'synthetic'] }, 1, 3),
  maxPrecision: { enum: ['coarse', 'exact', 'redacted'] }
}, ['allowedModes'])

export const SYSTEM_INFORMATION_SANDBOX_V2_SCHEMA = strictObject({
  defaultMode: { const: 'unavailable' },
  fields: Object.freeze({
    additionalProperties: false,
    properties: Object.fromEntries(SYSTEM_INFORMATION_FIELDS_V1.map(field => [field, systemCeiling])),
    type: 'object'
  })
})

const deviceCeiling = strictObject({
  access: { const: 'allow' },
  maxPrecision: { enum: ['coarse', 'exact', 'standard'] },
  maxPrivacyTier: integerSchema(0, 3)
})

export const DEVICE_SANDBOX_V2_SCHEMA = strictObject({
  defaultAccess: { const: 'deny' },
  maxEventsPerSecond: integerSchema(1, 1000),
  maxQueuedEvents: integerSchema(0, 4096),
  maxSubscriptions: integerSchema(0, 256),
  operations: Object.freeze({
    additionalProperties: false,
    properties: Object.fromEntries(DEVICE_OPERATIONS_V1.map(operation => [operation, deviceCeiling])),
    type: 'object'
  })
})

export const DIAGNOSTICS_SANDBOX_V2_SCHEMA = strictObject({
  maxObserverCallbackMs: integerSchema(1, 120_000),
  maxQueuedEvents: integerSchema(0, 4096),
  maxSourceReadBytes: integerSchema(0, 1024 * 1024),
  observerEvents: stringSetSchema({ enum: OBSERVER_EVENTS_V1 }, 0, OBSERVER_EVENTS_V1.length),
  retentionMs: integerSchema(0, 86_400_000),
  sourceReader: { enum: ['boundedSource', 'metadataOnly', 'none'] }
})
