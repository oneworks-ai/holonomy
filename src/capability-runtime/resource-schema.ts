import type { JsonSchema } from './schema-primitives.js'
import { integerSchema, strictObject } from './schema-primitives.js'

export const DIGEST_V1_SCHEMA: JsonSchema = {
  pattern: '^[0-9a-f]{64}$',
  type: 'string'
}
const identifier: JsonSchema = {
  maxLength: 128,
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
  type: 'string'
}
const display = strictObject({
  label: { maxLength: 256, minLength: 1, type: 'string' }
})
const common = {
  display,
  schemaVersion: { const: 1 },
  semanticId: { maxLength: 4096, minLength: 1, type: 'string' },
  semanticResourceDigest: DIGEST_V1_SCHEMA
}

export const FILESYSTEM_RESOURCE_V1_SCHEMA = strictObject({
  ...common,
  kind: { const: 'filesystem' },
  pathSegments: {
    items: { maxLength: 255, minLength: 1, type: 'string' },
    maxItems: 256,
    type: 'array'
  },
  rootId: { maxLength: 64, minLength: 1, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$', type: 'string' },
  virtualUrl: { maxLength: 4096, pattern: '^holo-fs://[A-Za-z0-9][A-Za-z0-9._-]*/', type: 'string' }
})

export const NETWORK_RESOURCE_V1_SCHEMA = strictObject({
  ...common,
  kind: { const: 'network' },
  method: { maxLength: 32, pattern: '^[A-Z]+$', type: 'string' },
  origin: { maxLength: 4096, minLength: 1, type: 'string' },
  pathname: { maxLength: 4096, pattern: '^/', type: 'string' },
  queryDigest: DIGEST_V1_SCHEMA
}, ['display', 'kind', 'method', 'origin', 'pathname', 'schemaVersion', 'semanticId', 'semanticResourceDigest'])

export const DEVICE_FIELD_RESOURCE_V1_SCHEMA = strictObject({
  ...common,
  field: { maxLength: 256, minLength: 1, type: 'string' },
  kind: { const: 'deviceField' },
  operation: { maxLength: 256, pattern: '^device\\.', type: 'string' },
  privacyTier: integerSchema(0, 3)
})

export const SYSTEM_INFORMATION_FIELD_RESOURCE_V1_SCHEMA = strictObject({
  ...common,
  field: { maxLength: 128, minLength: 1, type: 'string' },
  kind: { const: 'systemField' }
})

export const OPAQUE_HANDLE_RESOURCE_V1_SCHEMA = strictObject({
  ...common,
  bridgeIdentityDigest: DIGEST_V1_SCHEMA,
  generation: integerSchema(1, Number.MAX_SAFE_INTEGER),
  kind: { const: 'opaqueHandle' },
  resourceType: identifier,
  rightsDigest: DIGEST_V1_SCHEMA
})

const processCommon = {
  ...common,
  cwdSemanticResourceDigest: DIGEST_V1_SCHEMA,
  environmentNamesDigest: DIGEST_V1_SCHEMA,
  environmentScope: { enum: ['processTree', 'runtime'] },
  kind: { const: 'processExecutable' },
  stdioDigest: DIGEST_V1_SCHEMA
}
const processRequired = [
  'display',
  'environmentNamesDigest',
  'environmentScope',
  'invocation',
  'kind',
  'schemaVersion',
  'semanticId',
  'semanticResourceDigest',
  'stdioDigest'
]

export const PROCESS_EXECUTABLE_RESOURCE_V1_SCHEMA: JsonSchema = Object.freeze({
  oneOf: [
    strictObject({
      ...processCommon,
      argvDigest: DIGEST_V1_SCHEMA,
      executableId: identifier,
      invocation: { const: 'program' }
    }, [...processRequired, 'argvDigest', 'executableId']),
    strictObject({
      ...processCommon,
      commandDigest: DIGEST_V1_SCHEMA,
      invocation: { const: 'shell' },
      shellExecutableId: identifier
    }, [...processRequired, 'commandDigest', 'shellExecutableId'])
  ]
})

export const PROCESS_INSTANCE_RESOURCE_V1_SCHEMA = strictObject({
  ...common,
  executableSemanticResourceDigest: DIGEST_V1_SCHEMA,
  generation: integerSchema(1, Number.MAX_SAFE_INTEGER),
  kind: { const: 'processInstance' },
  processResourceId: identifier
})

export const PROCESS_NETWORK_ENDPOINT_RESOURCE_V1_SCHEMA = strictObject({
  ...common,
  hostname: { maxLength: 253, minLength: 1, type: 'string' },
  kind: { const: 'processNetworkEndpoint' },
  port: integerSchema(1, 65_535),
  transport: { enum: ['tcp', 'tls'] }
})

export const CANONICAL_RESOURCE_V1_SCHEMA: JsonSchema = Object.freeze({
  $id: 'https://oneworks.ai/holonomy/contracts/canonical-resource-v1.schema.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  oneOf: [
    FILESYSTEM_RESOURCE_V1_SCHEMA,
    NETWORK_RESOURCE_V1_SCHEMA,
    DEVICE_FIELD_RESOURCE_V1_SCHEMA,
    OPAQUE_HANDLE_RESOURCE_V1_SCHEMA,
    PROCESS_EXECUTABLE_RESOURCE_V1_SCHEMA,
    PROCESS_INSTANCE_RESOURCE_V1_SCHEMA,
    PROCESS_NETWORK_ENDPOINT_RESOURCE_V1_SCHEMA,
    SYSTEM_INFORMATION_FIELD_RESOURCE_V1_SCHEMA
  ]
})

export const INVOCATION_RESOURCE_BINDING_V1_SCHEMA = strictObject({
  generation: integerSchema(1, Number.MAX_SAFE_INTEGER),
  hop: integerSchema(0, 128),
  invocationBindingDigest: DIGEST_V1_SCHEMA,
  requestId: identifier,
  semanticResourceDigest: DIGEST_V1_SCHEMA,
  subrequestId: identifier
}, ['generation', 'invocationBindingDigest', 'requestId', 'semanticResourceDigest'])
