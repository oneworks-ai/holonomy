import { integerSchema, noneSchema, strictObject, stringSetSchema } from '@holonomyjs/runtime/kernel/schema-primitives'
import type { JsonSchema } from '@holonomyjs/runtime/kernel/schema-primitives'
import { STORAGE_LIMIT_MAXIMA_V2 } from './storage-policy.js'
import { STORAGE_LIMIT_NAMES_V2, STORAGE_OPERATIONS_V1 } from './storage-types.js'

const scalar: JsonSchema = {
  pattern: '^(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$',
  type: 'string'
}
const text = (maximum: number, minimum = 1): JsonSchema => ({ ...scalar, maxLength: maximum, minLength: minimum })
const namespaceId: JsonSchema = {
  maxLength: 128,
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
  type: 'string'
}

const limits = strictObject(Object.fromEntries(STORAGE_LIMIT_NAMES_V2.map(name => [
  name,
  integerSchema(1, STORAGE_LIMIT_MAXIMA_V2[name])
])))
const namespace = strictObject({
  databases: stringSetSchema(text(128), 0, 64),
  keyPrefixes: stringSetSchema(text(1024, 0), 0, 64),
  namespaceId,
  operations: stringSetSchema({ enum: STORAGE_OPERATIONS_V1 }, 1, STORAGE_OPERATIONS_V1.length)
})

export const STORAGE_CAPABILITY_CONSTRAINTS_V1_SCHEMA: JsonSchema = strictObject({
  databases: stringSetSchema(text(128), 0, 64),
  keyPrefixes: stringSetSchema(text(1024, 0), 0, 64),
  limits,
  namespaceId,
  operations: stringSetSchema({ enum: STORAGE_OPERATIONS_V1 }, 1, STORAGE_OPERATIONS_V1.length)
})

export const STORAGE_SANDBOX_V2_SCHEMA: JsonSchema = Object.freeze({
  oneOf: [
    noneSchema,
    strictObject({
      access: { const: 'sandboxed' },
      limits,
      namespaces: {
        items: namespace,
        maxItems: 64,
        minItems: 1,
        type: 'array'
      }
    })
  ]
})
