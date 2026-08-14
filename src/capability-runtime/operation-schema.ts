import { CAPABILITY_DEFINITION_REGISTRY_V1 } from './capability-registry.js'
import { OPERATION_REGISTRY_V1 } from './operation-registry.js'
import type { JsonSchema } from './schema-primitives.js'
import { strictObject, stringSetSchema } from './schema-primitives.js'

const id: JsonSchema = {
  maxLength: 256,
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:/→-]*$',
  type: 'string'
}
const capabilityRef = strictObject({
  name: { enum: CAPABILITY_DEFINITION_REGISTRY_V1.map(item => item.name) },
  version: { const: 1 }
})
const template = strictObject({
  anyOf: {
    items: strictObject({
      allOf: { items: capabilityRef, maxItems: 64, minItems: 1, type: 'array' },
      branchId: id
    }),
    maxItems: 64,
    minItems: 1,
    type: 'array'
  }
})
const capability: JsonSchema = {
  oneOf: [
    template,
    strictObject({ kind: { const: 'dynamic' }, schemaId: id }),
    strictObject({ kind: { const: 'inherited' } }),
    strictObject({ kind: { const: 'unavailable' } })
  ]
}
const resultVariant = strictObject({
  resultSchemaId: id,
  whenArgumentsSchemaId: id
})

export const OPERATION_DESCRIPTOR_V1_SCHEMA = strictObject({
  argsSchemaId: id,
  capability,
  deliverySchemaId: id,
  interception: { enum: ['host', 'systemOnly'] },
  kind: { enum: ['close', 'invoke', 'open', 'read', 'subscribe', 'write'] },
  limitsOwner: { maxLength: 256, minLength: 1, type: 'string' },
  member: { maxLength: 256, minLength: 1, type: 'string' },
  modes: stringSetSchema({ enum: ['callback', 'promise', 'sync'] }, 0, 3),
  module: { maxLength: 256, minLength: 1, type: 'string' },
  operation: { maxLength: 256, minLength: 1, type: 'string' },
  resourceSchemaId: id,
  resultSchemaId: id,
  resultVariants: { items: resultVariant, maxItems: 16, minItems: 1, type: 'array' }
}, [
  'argsSchemaId',
  'capability',
  'deliverySchemaId',
  'interception',
  'kind',
  'limitsOwner',
  'member',
  'modes',
  'module',
  'operation',
  'resourceSchemaId',
  'resultSchemaId'
])

const descriptorSchema = (row: (typeof OPERATION_REGISTRY_V1)[number]): JsonSchema =>
  strictObject({
    argsSchemaId: { const: row.argsSchemaId },
    capability: { const: row.capability },
    deliverySchemaId: { const: row.deliverySchemaId },
    interception: { const: row.interception },
    kind: { const: row.kind },
    limitsOwner: { const: row.limitsOwner },
    member: { const: row.member },
    modes: { const: row.modes },
    module: { const: row.module },
    operation: { const: row.operation },
    resourceSchemaId: { const: row.resourceSchemaId },
    resultSchemaId: { const: row.resultSchemaId },
    ...(row.resultVariants === undefined
      ? {}
      : { resultVariants: { const: row.resultVariants } })
  }, [
    'argsSchemaId',
    'capability',
    'deliverySchemaId',
    'interception',
    'kind',
    'limitsOwner',
    'member',
    'modes',
    'module',
    'operation',
    'resourceSchemaId',
    'resultSchemaId',
    ...(row.resultVariants === undefined ? [] : ['resultVariants'])
  ])

export const OPERATION_REGISTRY_V1_SCHEMA = Object.freeze({
  $id: 'https://oneworks.ai/holonomy/contracts/operation-registry-v1.schema.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  items: false,
  maxItems: OPERATION_REGISTRY_V1.length,
  minItems: OPERATION_REGISTRY_V1.length,
  prefixItems: OPERATION_REGISTRY_V1.map(descriptorSchema),
  type: 'array'
})
