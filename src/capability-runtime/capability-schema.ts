import { CAPABILITY_DEFINITION_REGISTRY_V1 } from './capability-registry.js'
import { processCapabilityConstraintsSchema } from './process-capability-schema.js'
import { DEVICE_OPERATIONS_V1, SYSTEM_INFORMATION_FIELDS_V1 } from './registry-types.js'
import type { JsonSchema } from './schema-primitives.js'
import { integerSchema, strictObject, stringSetSchema } from './schema-primitives.js'

const id: JsonSchema = {
  maxLength: 128,
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
  type: 'string'
}
const moduleId: JsonSchema = {
  maxLength: 128,
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
  type: 'string'
}
const fsLimits = strictObject({
  maxDirectoryEntries: integerSchema(0, 4 * 1024 * 1024 * 1024),
  maxOpenHandles: integerSchema(0, 4 * 1024 * 1024 * 1024),
  maxReadBytes: integerSchema(0, 4 * 1024 * 1024 * 1024),
  maxWatchers: integerSchema(0, 4 * 1024 * 1024 * 1024),
  maxWriteBytes: integerSchema(0, 4 * 1024 * 1024 * 1024)
})
const fs = strictObject({
  limits: fsLimits,
  roots: {
    items: strictObject({
      pathPrefixSegments: { items: id, maxItems: 256, type: 'array' },
      rights: stringSetSchema({ enum: ['create', 'delete', 'list', 'move', 'read', 'watch', 'write'] }, 1, 7),
      rootId: id
    }),
    maxItems: 64,
    minItems: 1,
    type: 'array'
  }
})
const networkLimits = strictObject({
  maxChunkBytes: integerSchema(0, 4 * 1024 * 1024 * 1024),
  maxConcurrentConnections: integerSchema(0, 4 * 1024 * 1024 * 1024),
  maxHeaderBytes: integerSchema(0, 4 * 1024 * 1024 * 1024),
  maxHeaders: integerSchema(0, 4 * 1024 * 1024 * 1024),
  maxRedirects: integerSchema(0, 4 * 1024 * 1024 * 1024),
  maxRequestBodyBytes: integerSchema(0, 4 * 1024 * 1024 * 1024),
  maxResponseBodyBytes: integerSchema(0, 4 * 1024 * 1024 * 1024),
  maxUrlBytes: integerSchema(0, 4 * 1024 * 1024 * 1024),
  socketTimeoutMs: integerSchema(0, 4 * 1024 * 1024 * 1024)
})
const network = (mode: 'mockOnly' | 'restricted') =>
  strictObject({
    allowPrivateNetwork: { type: 'boolean' },
    inspectRequestBodyBytes: integerSchema(0, 1024 * 1024),
    limits: networkLimits,
    mode: { const: mode },
    origins: stringSetSchema({ maxLength: 2048, minLength: 1, type: 'string' }, 0, 64),
    schemes: stringSetSchema({ enum: ['http', 'https'] }, 0, 2)
  })
const device = strictObject({
  maxPrecision: { enum: ['coarse', 'exact', 'standard'] },
  maxPrivacyTier: integerSchema(0, 3),
  operations: stringSetSchema({ enum: DEVICE_OPERATIONS_V1 }, 1, DEVICE_OPERATIONS_V1.length)
})
const system = strictObject({
  fields: stringSetSchema({ enum: SYSTEM_INFORMATION_FIELDS_V1 }, 1, SYSTEM_INFORMATION_FIELDS_V1.length),
  maxPrecision: { enum: ['coarse', 'exact', 'redacted'] },
  modes: stringSetSchema({ enum: ['real', 'redacted', 'synthetic'] }, 1, 3)
})
const reader = strictObject({
  maxReadBytes: integerSchema(0, 1024 * 1024),
  maxReads: integerSchema(0, 1024)
})
const credential = strictObject({
  stores: stringSetSchema(id, 0, 64),
  usages: stringSetSchema({ enum: ['gitHttp', 'httpAuthorization'] }, 1, 2)
})
const constraintsFor = (name: string): JsonSchema => {
  const processSchema = processCapabilityConstraintsSchema(name)
  if (processSchema != null) return processSchema
  if (name === 'host.fs') return fs
  if (name === 'host.network.http') return network('restricted')
  if (name === 'host.network.mock') return network('mockOnly')
  if (name.startsWith('host.device.')) return device
  if (name.startsWith('host.system.')) return system
  if (name === 'host.storage.credential') return credential
  return reader
}

const capabilityRefs = CAPABILITY_DEFINITION_REGISTRY_V1.map(definition =>
  strictObject({
    constraints: constraintsFor(definition.name),
    name: { const: definition.name },
    version: { const: 1 }
  })
)

export const CAPABILITY_REF_V1_SCHEMA: JsonSchema = Object.freeze({ oneOf: capabilityRefs })

const capabilityBindings = CAPABILITY_DEFINITION_REGISTRY_V1.map(definition =>
  strictObject({
    branchId: id,
    constraints: constraintsFor(definition.name),
    digest: { pattern: '^[0-9a-f]{64}$', type: 'string' },
    name: { const: definition.name },
    source: { const: 'policy' },
    version: { const: 1 }
  })
)

const authorityBindings = CAPABILITY_DEFINITION_REGISTRY_V1.map(definition =>
  strictObject({
    authorityDigest: { pattern: '^[0-9a-f]{64}$', type: 'string' },
    authorityVersion: { const: 1 },
    capabilityName: { const: definition.name },
    constraints: constraintsFor(definition.name),
    providerModule: { const: definition.providerModule }
  })
)

export const CAPABILITY_REQUIREMENT_V1_SCHEMA = strictObject({
  anyOf: {
    items: strictObject({
      allOf: { items: CAPABILITY_REF_V1_SCHEMA, maxItems: 64, minItems: 1, type: 'array' },
      branchId: id
    }),
    maxItems: 64,
    minItems: 1,
    type: 'array'
  }
})

export const CAPABILITY_BINDING_V1_SCHEMA: JsonSchema = Object.freeze({
  oneOf: capabilityBindings
})

export const AUTHORITY_BINDING_V1_SCHEMA: JsonSchema = Object.freeze({
  oneOf: authorityBindings
})

export const CAPABILITY_SELECTION_V1_SCHEMA: JsonSchema = strictObject({
  authorityBindings: {
    items: AUTHORITY_BINDING_V1_SCHEMA,
    maxItems: CAPABILITY_DEFINITION_REGISTRY_V1.length,
    minItems: 1,
    type: 'array'
  },
  bindings: {
    items: CAPABILITY_BINDING_V1_SCHEMA,
    maxItems: CAPABILITY_DEFINITION_REGISTRY_V1.length,
    minItems: 1,
    type: 'array'
  },
  branchId: id,
  requirement: CAPABILITY_REQUIREMENT_V1_SCHEMA
})

export const CAPABILITY_SELECTION_CONTRACT_V1_SCHEMA = Object.freeze({
  $defs: {
    authorityBinding: AUTHORITY_BINDING_V1_SCHEMA,
    binding: CAPABILITY_BINDING_V1_SCHEMA,
    capabilityRef: CAPABILITY_REF_V1_SCHEMA,
    requirement: CAPABILITY_REQUIREMENT_V1_SCHEMA,
    selection: CAPABILITY_SELECTION_V1_SCHEMA
  },
  $id: 'https://oneworks.ai/holonomy/contracts/capability-selection-v1.schema.json',
  $ref: '#/$defs/selection',
  $schema: 'https://json-schema.org/draft/2020-12/schema'
})

export const CAPABILITY_DEFINITION_REGISTRY_V1_SCHEMA = Object.freeze({
  $id: 'https://oneworks.ai/holonomy/contracts/capability-definition-registry-v1.schema.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  items: strictObject({
    constraintKind: {
      enum: ['credential', 'device', 'empty', 'filesystem', 'network', 'numericReader', 'process', 'system']
    },
    constraintSchemaId: id,
    name: { enum: CAPABILITY_DEFINITION_REGISTRY_V1.map(item => item.name) },
    providerModule: moduleId,
    version: { const: 1 }
  }),
  maxItems: CAPABILITY_DEFINITION_REGISTRY_V1.length,
  minItems: CAPABILITY_DEFINITION_REGISTRY_V1.length,
  type: 'array'
})
