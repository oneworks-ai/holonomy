import { NODE_GUEST_ERROR_CODES_V1 } from './error-schema.js'
import type { JsonSchema } from './schema-primitives.js'
import { integerSchema, strictObject } from './schema-primitives.js'

export const EMPTY_ARGS_SCHEMA_V1 = strictObject({})
export const VIRTUAL_PATH_SCHEMA_V1: JsonSchema = {
  maxLength: 4096,
  pattern: '^holo-fs://[A-Za-z0-9][A-Za-z0-9._-]*/',
  type: 'string'
}
export const DIGEST_SCHEMA_V1: JsonSchema = { pattern: '^[0-9a-f]{64}$', type: 'string' }
export const IDENTIFIER_SCHEMA_V1: JsonSchema = {
  maxLength: 128,
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
  type: 'string'
}
export const BINDING_SCHEMA_V1 = strictObject({
  bindingId: IDENTIFIER_SCHEMA_V1,
  generation: integerSchema(1, Number.MAX_SAFE_INTEGER)
})
export const BINARY_SCHEMA_V1 = strictObject({
  base64: { pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$', type: 'string' },
  byteLength: integerSchema(0, 256 * 1024 * 1024),
  sha256: DIGEST_SCHEMA_V1
})
export const DATA_SCHEMA_V1: JsonSchema = {
  oneOf: [{ maxLength: 256 * 1024 * 1024, type: 'string' }, BINARY_SCHEMA_V1]
}
export const NODE_ERROR_SNAPSHOT_SCHEMA_V1 = strictObject({
  code: { enum: NODE_GUEST_ERROR_CODES_V1 },
  message: { maxLength: 1024, minLength: 1, type: 'string' },
  name: { enum: ['AbortError', 'Error', 'TypeError'] },
  path: VIRTUAL_PATH_SCHEMA_V1,
  retryable: { type: 'boolean' },
  syscall: { maxLength: 128, minLength: 1, type: 'string' }
}, ['code', 'message', 'name', 'retryable'])
export const JSON_VALUE_SCHEMA_V1: JsonSchema = {
  $defs: {
    value: {
      oneOf: [
        { type: 'null' },
        { type: 'boolean' },
        { type: 'number' },
        { type: 'string' },
        { items: { $ref: '#/$defs/value' }, maxItems: 1024, type: 'array' },
        { additionalProperties: { $ref: '#/$defs/value' }, maxProperties: 1024, type: 'object' }
      ]
    }
  },
  $ref: '#/$defs/value'
}

export const resourceFacade = (resourceType: string): JsonSchema =>
  strictObject({
    binding: BINDING_SCHEMA_V1,
    resourceType: { const: resourceType }
  })
