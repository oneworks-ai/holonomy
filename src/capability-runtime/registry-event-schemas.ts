import { DEVICE_EVENT_V1_SCHEMA } from './device-schema.js'
import { BINARY_SCHEMA_V1, NODE_ERROR_SNAPSHOT_SCHEMA_V1 } from './registry-schema-primitives.js'
import type { JsonSchema } from './schema-primitives.js'
import { integerSchema, strictObject } from './schema-primitives.js'

const signal: JsonSchema = { oneOf: [{ type: 'null' }, { enum: ['SIGINT', 'SIGKILL', 'SIGTERM'] }] }
const exitTuple: JsonSchema = {
  items: false,
  maxItems: 2,
  minItems: 2,
  prefixItems: [{ oneOf: [{ type: 'null' }, integerSchema(0, 255)] }, signal],
  type: 'array'
}

export const REGISTRY_EVENT_SCHEMAS_V1: Readonly<Record<string, JsonSchema>> = Object.freeze({
  HoloDeviceEventV1: DEVICE_EVENT_V1_SCHEMA,
  ChildProcessEventV1: {
    oneOf: [
      strictObject({ event: { const: 'spawn' }, tuple: { maxItems: 0, type: 'array' } }),
      strictObject({
        event: { const: 'error' },
        tuple: {
          items: false,
          maxItems: 1,
          minItems: 1,
          prefixItems: [NODE_ERROR_SNAPSHOT_SCHEMA_V1],
          type: 'array'
        }
      }),
      strictObject({ event: { const: 'exit' }, tuple: exitTuple }),
      strictObject({ event: { const: 'close' }, tuple: exitTuple })
    ]
  },
  ChildProcessReadableEventV1: {
    oneOf: [
      strictObject({
        event: { const: 'data' },
        tuple: { items: false, maxItems: 1, minItems: 1, prefixItems: [BINARY_SCHEMA_V1], type: 'array' }
      }),
      strictObject({ event: { const: 'end' }, tuple: { maxItems: 0, type: 'array' } }),
      strictObject({
        event: { const: 'error' },
        tuple: {
          items: false,
          maxItems: 1,
          minItems: 1,
          prefixItems: [NODE_ERROR_SNAPSHOT_SCHEMA_V1],
          type: 'array'
        }
      }),
      strictObject({ event: { const: 'close' }, tuple: { maxItems: 0, type: 'array' } })
    ]
  },
  ChildProcessStdinEventV1: {
    oneOf: [
      strictObject({
        callbackId: integerSchema(1, Number.MAX_SAFE_INTEGER),
        error: { oneOf: [{ type: 'null' }, NODE_ERROR_SNAPSHOT_SCHEMA_V1] },
        event: { const: 'callback' }
      }),
      strictObject({ event: { const: 'close' } })
    ]
  },
  ProcessExecSuccessTupleV1: {
    items: false,
    maxItems: 2,
    minItems: 2,
    prefixItems: [
      { oneOf: [{ type: 'string' }, BINARY_SCHEMA_V1] },
      { oneOf: [{ type: 'string' }, BINARY_SCHEMA_V1] }
    ],
    type: 'array'
  },
  VirtualFsWatcherDeliveryV1: {
    oneOf: [
      strictObject({
        event: { const: 'change' },
        tuple: {
          items: false,
          maxItems: 2,
          minItems: 2,
          prefixItems: [{ enum: ['change', 'rename'] }, { oneOf: [{ type: 'null' }, { type: 'string' }] }],
          type: 'array'
        }
      }),
      strictObject({
        event: { const: 'error' },
        tuple: {
          items: false,
          maxItems: 1,
          minItems: 1,
          prefixItems: [NODE_ERROR_SNAPSHOT_SCHEMA_V1],
          type: 'array'
        }
      }),
      strictObject({ event: { const: 'close' }, tuple: { maxItems: 0, type: 'array' } })
    ]
  }
})
