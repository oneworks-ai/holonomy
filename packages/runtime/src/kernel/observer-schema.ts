import { OBSERVER_EVENTS_V1 } from './registry-types.js'
import type { JsonSchema } from './schema-primitives.js'
import { integerSchema, strictObject, stringSetSchema } from './schema-primitives.js'

const opaqueId: JsonSchema = {
  maxLength: 128,
  minLength: 1,
  pattern: '^[A-Za-z0-9._:-]+$',
  type: 'string'
}
const digest: JsonSchema = { pattern: '^[0-9a-f]{64}$', type: 'string' }

const observerDescriptor = strictObject({
  cost: { enum: ['high', 'low'] },
  event: { enum: OBSERVER_EVENTS_V1 },
  optIn: { type: 'boolean' },
  supportLevel: { enum: ['optional', 'required', 'unsupported'] }
})

export const RUNTIME_OBSERVER_PLATFORM_DESCRIPTOR_V1_SCHEMA = strictObject({
  events: {
    items: observerDescriptor,
    maxItems: OBSERVER_EVENTS_V1.length,
    minItems: OBSERVER_EVENTS_V1.length,
    type: 'array'
  },
  maxObserverCallbackMs: integerSchema(1, 120_000),
  maxQueuedEvents: integerSchema(0, 4096),
  schemaVersion: { const: 1 }
})

export const RUNTIME_OBSERVER_REGISTRATION_V1_SCHEMA = strictObject({
  acceptHighCost: { type: 'boolean' },
  callbackTimeoutMs: integerSchema(1, 120_000),
  events: stringSetSchema({ enum: OBSERVER_EVENTS_V1 }, 1, OBSERVER_EVENTS_V1.length),
  maxQueuedEvents: integerSchema(1, 4096)
}, ['events'])

export const OBSERVER_OVERFLOW_PAYLOAD_V1_SCHEMA = strictObject({
  dropped: integerSchema(1, Number.MAX_SAFE_INTEGER),
  droppedByEvent: {
    additionalProperties: false,
    maxProperties: OBSERVER_EVENTS_V1.length,
    minProperties: 1,
    properties: Object.fromEntries(OBSERVER_EVENTS_V1.map(event => [
      event,
      integerSchema(1, Number.MAX_SAFE_INTEGER)
    ])),
    type: 'object'
  },
  firstDroppedSequence: integerSchema(1, Number.MAX_SAFE_INTEGER),
  lastDroppedSequence: integerSchema(1, Number.MAX_SAFE_INTEGER)
})

const eventEnvelope = (event: string, payload: JsonSchema) =>
  strictObject({
    correlationId: opaqueId,
    event: { const: event },
    generation: integerSchema(1, Number.MAX_SAFE_INTEGER),
    observedAt: { maximum: Number.MAX_VALUE, minimum: 0, type: 'number' },
    payload,
    schemaVersion: { const: 1 },
    sequence: integerSchema(1, Number.MAX_SAFE_INTEGER)
  }, ['event', 'generation', 'observedAt', 'payload', 'schemaVersion', 'sequence'])

const stableError = strictObject({ code: opaqueId, scriptId: opaqueId }, ['code'])
const observerEvent: JsonSchema = {
  oneOf: [
    eventEnvelope(
      'script.compiled',
      strictObject({
        origin: { maxLength: 4096, minLength: 1, type: 'string' },
        scriptId: opaqueId,
        sourceBytes: integerSchema(0, 16 * 1024 * 1024),
        sourceSha256: digest
      }, ['scriptId', 'sourceBytes', 'sourceSha256'])
    ),
    eventEnvelope(
      'script.execution-started',
      strictObject({
        executionId: opaqueId,
        scriptId: opaqueId
      })
    ),
    eventEnvelope(
      'script.execution-finished',
      strictObject({
        executionId: opaqueId,
        outcome: { enum: ['completed', 'terminated', 'threw'] },
        scriptId: opaqueId
      })
    ),
    eventEnvelope('promise.rejected', stableError),
    eventEnvelope('runtime.exception', stableError),
    eventEnvelope(
      'runtime.terminated',
      strictObject({
        reason: { enum: ['completed', 'failed', 'lost', 'stopped'] }
      })
    ),
    eventEnvelope(
      'memory.pressure',
      strictObject({
        level: { enum: ['critical', 'moderate'] }
      })
    ),
    eventEnvelope(
      'gc.completed',
      strictObject({
        durationMs: { maximum: 120_000, minimum: 0, type: 'number' },
        reclaimedBytes: integerSchema(0, Number.MAX_SAFE_INTEGER)
      }, ['durationMs'])
    ),
    eventEnvelope('observer.overflow', OBSERVER_OVERFLOW_PAYLOAD_V1_SCHEMA)
  ]
}

export const OBSERVER_CONTRACT_V1_SCHEMA = Object.freeze({
  $defs: {
    event: observerEvent,
    overflow: OBSERVER_OVERFLOW_PAYLOAD_V1_SCHEMA,
    platformDescriptor: RUNTIME_OBSERVER_PLATFORM_DESCRIPTOR_V1_SCHEMA,
    registration: RUNTIME_OBSERVER_REGISTRATION_V1_SCHEMA
  },
  $id: 'https://oneworks.ai/holonomy/contracts/observer-v1.schema.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema'
})
