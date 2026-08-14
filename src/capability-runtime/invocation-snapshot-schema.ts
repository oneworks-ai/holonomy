import type { JsonSchema } from './schema-primitives.js'
import { integerSchema, strictObject } from './schema-primitives.js'

const digest = { pattern: '^[0-9a-f]{64}$', type: 'string' }
const bindingId = { maxLength: 128, minLength: 1, pattern: '^[a-zA-Z0-9._-]+$', type: 'string' }
const scalar: JsonSchema = strictObject({
  kind: { const: 'scalar' },
  value: {
    oneOf: [
      { type: 'null' },
      { type: 'boolean' },
      { type: 'number' },
      { type: 'string' }
    ]
  }
})
const arrayNode = (nodeReference: JsonSchema) =>
  strictObject({
    items: { items: nodeReference, maxItems: 1024, type: 'array' },
    kind: { const: 'array' }
  })
const objectNode = (nodeReference: JsonSchema) =>
  strictObject({
    entries: {
      items: strictObject({ key: { maxLength: 16_384, type: 'string' }, value: nodeReference }),
      maxItems: 1024,
      type: 'array'
    },
    kind: { const: 'object' }
  })
const binaryNode = strictObject({
  bindingId,
  byteLength: integerSchema(0, 256 * 1024 * 1024),
  kind: { const: 'binary' },
  sha256: digest
})
const bindingNode = (types: readonly string[]) =>
  strictObject({
    bindingId,
    bindingType: { enum: types },
    generation: integerSchema(1, Number.MAX_SAFE_INTEGER),
    kind: { const: 'binding' }
  })
const errorNode = strictObject({
  code: { maxLength: 128, minLength: 1, type: 'string' },
  kind: { const: 'stableError' }
})

export const INVOCATION_SNAPSHOT_ENVELOPE_V1_SCHEMA = Object.freeze({
  $defs: {
    argumentNode: {
      oneOf: [
        scalar,
        arrayNode({ $ref: '#/$defs/argumentNode' }),
        objectNode({ $ref: '#/$defs/argumentNode' }),
        binaryNode,
        bindingNode(['abortSignal', 'callback', 'resource']),
        errorNode
      ]
    },
    resultNode: {
      oneOf: [
        scalar,
        arrayNode({ $ref: '#/$defs/resultNode' }),
        objectNode({ $ref: '#/$defs/resultNode' }),
        binaryNode,
        bindingNode(['resource']),
        errorNode
      ]
    }
  },
  $id: 'https://oneworks.ai/holonomy/contracts/invocation-snapshot-v1.schema.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  oneOf: [
    strictObject({
      direction: { const: 'argument' },
      root: { $ref: '#/$defs/argumentNode' },
      schemaVersion: { const: 1 }
    }),
    strictObject({
      direction: { const: 'result' },
      root: { $ref: '#/$defs/resultNode' },
      schemaVersion: { const: 1 }
    })
  ]
})
