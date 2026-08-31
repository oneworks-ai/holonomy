import {
  DIGEST_V1_SCHEMA,
  FILESYSTEM_RESOURCE_V1_SCHEMA,
  NETWORK_RESOURCE_V1_SCHEMA,
  OPAQUE_HANDLE_RESOURCE_V1_SCHEMA,
  PROCESS_NETWORK_ENDPOINT_RESOURCE_V1_SCHEMA
} from './resource-schema.js'
import type { JsonSchema } from './schema-primitives.js'
import { integerSchema, strictObject, stringSetSchema } from './schema-primitives.js'

const id: JsonSchema = {
  maxLength: 128,
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
  type: 'string'
}
const finiteTime: JsonSchema = { maximum: Number.MAX_SAFE_INTEGER, minimum: 0, type: 'number' }

export const RESOLUTION_EVIDENCE_V1_SCHEMA: JsonSchema = Object.freeze({
  oneOf: [
    strictObject({
      addresses: stringSetSchema({ maxLength: 64, minLength: 2, type: 'string' }, 1, 64),
      expiresAtMonotonicMs: finiteTime,
      kind: { const: 'networkAddress' },
      resolverGeneration: integerSchema(0, Number.MAX_SAFE_INTEGER)
    }),
    strictObject({
      ancestorIdentityDigests: { items: DIGEST_V1_SCHEMA, maxItems: 256, type: 'array' },
      kind: { const: 'filesystemTarget' },
      rootId: { maxLength: 64, minLength: 1, type: 'string' },
      targetIdentityDigest: DIGEST_V1_SCHEMA,
      targetType: { enum: ['directory', 'file', 'missing', 'symlink'] }
    }),
    strictObject({
      bridgeIdentityDigest: DIGEST_V1_SCHEMA,
      generation: integerSchema(1, Number.MAX_SAFE_INTEGER),
      kind: { const: 'opaqueIdentity' },
      rightsDigest: DIGEST_V1_SCHEMA
    })
  ]
})

const binding = (kind: string): JsonSchema =>
  strictObject({
    bindingId: id,
    evidenceDigest: DIGEST_V1_SCHEMA,
    kind: { const: kind }
  })
const challenge = (
  reason: string,
  evidenceKind: string,
  resource: JsonSchema
): JsonSchema =>
  strictObject({
    challengeId: id,
    evidence: binding(evidenceKind),
    parentRequestId: id,
    reason: { const: reason },
    requested: resource,
    resolved: resource,
    schemaVersion: { const: 1 },
    sequence: integerSchema(1, 32)
  })

export const RESOLVED_RESOURCE_CHALLENGE_V1_SCHEMA: JsonSchema = Object.freeze({
  oneOf: [
    challenge('networkAddress', 'networkAddress', NETWORK_RESOURCE_V1_SCHEMA),
    challenge('networkAddress', 'networkAddress', PROCESS_NETWORK_ENDPOINT_RESOURCE_V1_SCHEMA),
    challenge('filesystemTarget', 'filesystemTarget', FILESYSTEM_RESOURCE_V1_SCHEMA),
    challenge('opaqueRebind', 'opaqueIdentity', OPAQUE_HANDLE_RESOURCE_V1_SCHEMA)
  ]
})

export const RESOLUTION_ADMISSION_TOKEN_V1_SCHEMA = strictObject({
  challengeId: id,
  evidenceDigest: DIGEST_V1_SCHEMA,
  expiresAtMonotonicMs: finiteTime,
  generation: integerSchema(1, Number.MAX_SAFE_INTEGER),
  invocationBindingDigest: DIGEST_V1_SCHEMA,
  parentRequestId: id,
  requestedSemanticDigest: DIGEST_V1_SCHEMA,
  resolvedSemanticDigest: DIGEST_V1_SCHEMA,
  sequence: integerSchema(1, 32),
  tokenId: id
})

export const RESOLUTION_CONTRACT_V1_SCHEMA = Object.freeze({
  $defs: {
    admissionToken: RESOLUTION_ADMISSION_TOKEN_V1_SCHEMA,
    challenge: RESOLVED_RESOURCE_CHALLENGE_V1_SCHEMA,
    evidence: RESOLUTION_EVIDENCE_V1_SCHEMA
  },
  $id: 'https://oneworks.ai/holonomy/contracts/resource-resolution-v1.schema.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema'
})
