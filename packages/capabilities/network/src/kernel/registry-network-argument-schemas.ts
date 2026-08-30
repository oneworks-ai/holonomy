import { DIGEST_SCHEMA_V1, IDENTIFIER_SCHEMA_V1 } from '@holonomyjs/runtime/kernel/registry-schema-primitives'
import { NETWORK_RESOURCE_V1_SCHEMA } from '@holonomyjs/runtime/kernel/resource-schema'
import type { JsonSchema } from '@holonomyjs/runtime/kernel/schema-primitives'
import { integerSchema, strictObject } from '@holonomyjs/runtime/kernel/schema-primitives'

const HTTP_VALUE_SCHEMA_V1: JsonSchema = {
  maxLength: 65_536,
  type: 'string'
}
const visibleEntry = (key: 'key' | 'name'): JsonSchema =>
  strictObject({
    index: integerSchema(0, 1023),
    [key]: {
      maxLength: 4096,
      minLength: key === 'name' ? 1 : 0,
      type: 'string'
    },
    value: HTTP_VALUE_SCHEMA_V1,
    visibility: { const: 'visible' }
  })
const redactedEntry = (key: 'key' | 'name'): JsonSchema =>
  strictObject({
    index: integerSchema(0, 1023),
    [key]: {
      maxLength: 4096,
      minLength: key === 'name' ? 1 : 0,
      type: 'string'
    },
    visibility: { const: 'redacted' }
  })

export const NETWORK_HEADER_VIEW_V1_SCHEMA: JsonSchema = {
  oneOf: [
    visibleEntry('name'),
    redactedEntry('name')
  ]
}
const NETWORK_QUERY_VIEW_V1_SCHEMA: JsonSchema = {
  oneOf: [
    visibleEntry('key'),
    redactedEntry('key')
  ]
}
const NETWORK_BODY_METADATA_V1_SCHEMA: JsonSchema = {
  oneOf: [
    strictObject({ kind: { const: 'none' }, length: { const: 0 } }),
    strictObject({
      kind: { const: 'buffered' },
      length: integerSchema(0, 64 * 1024 * 1024),
      sha256: DIGEST_SCHEMA_V1
    })
  ]
}

export const NETWORK_INVOCATION_SNAPSHOT_V1_SCHEMA = strictObject({
  body: NETWORK_BODY_METADATA_V1_SCHEMA,
  headerDigest: DIGEST_SCHEMA_V1,
  headers: {
    items: NETWORK_HEADER_VIEW_V1_SCHEMA,
    maxItems: 1024,
    type: 'array'
  },
  hop: integerSchema(0, 128),
  logicalRequestId: IDENTIFIER_SCHEMA_V1,
  method: {
    maxLength: 32,
    pattern: '^[A-Z]+$',
    type: 'string'
  },
  query: {
    items: NETWORK_QUERY_VIEW_V1_SCHEMA,
    maxItems: 1024,
    type: 'array'
  },
  queryDigest: DIGEST_SCHEMA_V1,
  resource: NETWORK_RESOURCE_V1_SCHEMA,
  schemaVersion: { const: 1 }
})

export const NETWORK_REDIRECT_INVOCATION_V1_SCHEMA = strictObject({
  bodyReplay: { enum: ['none', 'same-buffered-body'] },
  fromHop: integerSchema(0, 127),
  fromRequest: NETWORK_INVOCATION_SNAPSHOT_V1_SCHEMA,
  logicalRequestId: IDENTIFIER_SCHEMA_V1,
  methodRewritten: { type: 'boolean' },
  status: { enum: [301, 302, 303, 307, 308] },
  toHop: integerSchema(1, 128),
  toRequest: NETWORK_INVOCATION_SNAPSHOT_V1_SCHEMA
})

export const NETWORK_ARGUMENT_SCHEMAS_V1: Readonly<Record<string, JsonSchema>> = Object.freeze({
  NetworkInvocationSnapshotV1: NETWORK_INVOCATION_SNAPSHOT_V1_SCHEMA,
  NetworkRedirectInvocationV1: NETWORK_REDIRECT_INVOCATION_V1_SCHEMA
})
