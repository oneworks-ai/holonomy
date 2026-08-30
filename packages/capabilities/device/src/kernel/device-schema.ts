import { DEVICE_OPERATIONS_V1 } from '@holonomyjs/runtime/kernel/registry-types'
import type { JsonSchema } from '@holonomyjs/runtime/kernel/schema-primitives'
import { integerSchema, strictObject } from '@holonomyjs/runtime/kernel/schema-primitives'
import {
  DEVICE_EVENT_KINDS_V1,
  DEVICE_PROVIDER_REQUIRED_EVENTS_V1,
  DEVICE_PROVIDER_REQUIRED_OPERATIONS_V1
} from './device-provider.js'
import type { DeviceValueOperationV1 } from './device-types.js'
import { DEVICE_VALUE_SCHEMAS_V1 } from './device-value-schemas.js'

const observedAt: JsonSchema = { maximum: Number.MAX_SAFE_INTEGER, minimum: 0, type: 'number' }
const revision = integerSchema(0, Number.MAX_SAFE_INTEGER)

export const deviceReadingSchemaV1 = (operation: DeviceValueOperationV1): JsonSchema => ({
  oneOf: [
    strictObject({
      observedAt,
      precision: { enum: ['coarse', 'exact', 'standard'] },
      revision,
      status: { const: 'available' },
      value: DEVICE_VALUE_SCHEMAS_V1[operation]!
    }),
    strictObject({
      observedAt,
      precision: { const: 'redacted' },
      revision,
      status: { const: 'redacted' },
      value: DEVICE_VALUE_SCHEMAS_V1[operation]!
    }),
    strictObject({
      observedAt,
      precision: { const: 'none' },
      revision,
      status: { enum: ['permissionDenied', 'unavailable', 'unsupported'] }
    })
  ]
})

export const DEVICE_SUMMARY_V1_SCHEMA = strictObject({
  display: deviceReadingSchemaV1('device.display.read'),
  formFactor: deviceReadingSchemaV1('device.form-factor.read'),
  input: deviceReadingSchemaV1('device.input.read'),
  lifecycle: deviceReadingSchemaV1('device.lifecycle.read'),
  power: deviceReadingSchemaV1('device.power.read'),
  schemaVersion: { const: 1 }
})

const exactArray = (values: readonly string[]): JsonSchema =>
  values.length === 0
    ? { maxItems: 0, type: 'array' }
    : {
      items: false,
      maxItems: values.length,
      minItems: values.length,
      prefixItems: values.map(value => ({ const: value })),
      type: 'array'
    }

const unsupportedOperation = (operation: string): JsonSchema =>
  strictObject({
    eventKinds: exactArray([]),
    maxPrecision: { const: 'none' },
    operation: { const: operation },
    permissionModel: { const: 'none' },
    supportLevel: { const: 'unsupported' }
  })

const supportedOperation = (
  operation: string,
  supportLevel: 'optional' | 'required',
  events: readonly string[]
): JsonSchema =>
  strictObject({
    eventKinds: exactArray(events),
    maxPrecision: { enum: ['coarse', 'exact', 'redacted', 'standard'] },
    operation: { const: operation },
    permissionModel: { enum: ['host', 'hostAndPlatform', 'none', 'platform'] },
    supportLevel: { const: supportLevel }
  })

const providerDescriptor = (target: 'android' | 'desktop' | 'node'): JsonSchema => {
  const required = new Set(DEVICE_PROVIDER_REQUIRED_OPERATIONS_V1[target])
  const operations = DEVICE_OPERATIONS_V1.map(operation => {
    const events = operation === 'device.events.subscribe'
      ? DEVICE_PROVIDER_REQUIRED_EVENTS_V1[target]
      : []
    if (required.has(operation)) return supportedOperation(operation, 'required', events)
    if (target === 'node') return unsupportedOperation(operation)
    return { oneOf: [supportedOperation(operation, 'optional', []), unsupportedOperation(operation)] }
  })
  return strictObject({
    operations: {
      items: false,
      maxItems: operations.length,
      minItems: operations.length,
      prefixItems: operations,
      type: 'array'
    },
    providerVersion: { maxLength: 64, minLength: 1, type: 'string' },
    schemaVersion: { const: 1 },
    target: { const: target }
  })
}

export const DEVICE_PROVIDER_DESCRIPTOR_V1_SCHEMA: JsonSchema = Object.freeze({
  oneOf: [providerDescriptor('android'), providerDescriptor('desktop'), providerDescriptor('node')]
})

const EVENT_OPERATION = Object.freeze(
  {
    connectivity: 'device.connectivity.read',
    display: 'device.display.read',
    lifecycle: 'device.lifecycle.read',
    power: 'device.power.read',
    thermal: 'device.thermal.read'
  } as const
)

const eventSchemas = DEVICE_EVENT_KINDS_V1.map(kind =>
  strictObject({
    kind: { const: kind },
    observedAt,
    phase: { enum: ['change', 'snapshot'] },
    reading: deviceReadingSchemaV1(EVENT_OPERATION[kind]),
    schemaVersion: { const: 1 },
    sequence: integerSchema(1, Number.MAX_SAFE_INTEGER)
  })
)

export const DEVICE_EVENT_V1_SCHEMA: JsonSchema = Object.freeze({
  oneOf: [
    ...eventSchemas,
    strictObject({
      dropped: integerSchema(1, Number.MAX_SAFE_INTEGER),
      kind: { const: 'overflow' },
      observedAt,
      requiredRevisions: {
        additionalProperties: false,
        maxProperties: DEVICE_EVENT_KINDS_V1.length,
        minProperties: 1,
        properties: Object.fromEntries(DEVICE_EVENT_KINDS_V1.map(kind => [kind, revision])),
        type: 'object'
      },
      resyncRequired: { const: true },
      schemaVersion: { const: 1 },
      sequence: integerSchema(1, Number.MAX_SAFE_INTEGER)
    })
  ]
})

export const DEVICE_SUBSCRIPTION_RESOURCE_V1_SCHEMA: JsonSchema = strictObject({
  binding: strictObject({
    bindingId: { maxLength: 128, minLength: 1, pattern: '^[A-Za-z][A-Za-z0-9._-]*$', type: 'string' },
    generation: integerSchema(1, Number.MAX_SAFE_INTEGER)
  }),
  maxQueuedEvents: integerSchema(1, 4096),
  resourceType: { const: 'device.subscription' },
  startSequence: integerSchema(0, Number.MAX_SAFE_INTEGER)
})

export const DEVICE_CONTRACT_V1_SCHEMA = Object.freeze({
  $defs: {
    events: DEVICE_EVENT_V1_SCHEMA,
    providerDescriptor: DEVICE_PROVIDER_DESCRIPTOR_V1_SCHEMA,
    summary: DEVICE_SUMMARY_V1_SCHEMA,
    values: strictObject(DEVICE_VALUE_SCHEMAS_V1)
  },
  $id: 'https://oneworks.ai/holonomy/contracts/device-v1.schema.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema'
})
