import { strictObject } from '@holonomyjs/runtime/kernel/schema-primitives'
import type { JsonSchema } from '@holonomyjs/runtime/kernel/schema-primitives'

const digest: JsonSchema = { pattern: '^[0-9a-f]{64}$', type: 'string' }
const namespaceId: JsonSchema = {
  maxLength: 128,
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
  type: 'string'
}
const common = {
  display: strictObject({ label: { maxLength: 256, minLength: 1, type: 'string' } }),
  namespaceId,
  schemaVersion: { const: 1 },
  semanticId: { maxLength: 4096, minLength: 1, type: 'string' },
  semanticResourceDigest: digest
}

export const STORAGE_KV_RESOURCE_V1_SCHEMA = strictObject({
  ...common,
  kind: { const: 'storageKv' },
  selector: { enum: ['key', 'prefix'] },
  selectorDigest: digest
})

export const STORAGE_SQL_RESOURCE_V1_SCHEMA = strictObject({
  ...common,
  database: {
    maxLength: 128,
    minLength: 1,
    pattern: '^(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$',
    type: 'string'
  },
  kind: { const: 'storageSql' }
})
