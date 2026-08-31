import { FACADE_DELIVERY_REGISTRY_V1 } from './facade-delivery.js'
import { OPERATION_SCHEMA_OWNER_REGISTRY_V1 } from './registry-schema-ids.js'
import type { JsonSchema } from './schema-primitives.js'
import { strictObject, stringSetSchema } from './schema-primitives.js'

const id: JsonSchema = { maxLength: 256, minLength: 1, type: 'string' }
const terminalSuccess: JsonSchema = {
  oneOf: [
    strictObject({ kind: { const: 'void' } }),
    strictObject({ kind: { const: 'result' }, resultSchemaId: id }),
    strictObject({ kind: { const: 'tuple' }, tupleSchemaId: id })
  ]
}
const success: JsonSchema = {
  oneOf: [
    terminalSuccess,
    strictObject({
      kind: { const: 'variants' },
      variants: {
        items: strictObject({ delivery: terminalSuccess, whenArgumentsSchemaId: id }),
        maxItems: 16,
        minItems: 1,
        type: 'array'
      }
    })
  ]
}
const failure: JsonSchema = {
  oneOf: [
    strictObject({ kind: { const: 'errorOnly' } }),
    strictObject({ kind: { const: 'errorAndTuple' }, tupleSchemaId: id })
  ]
}
const callback = strictObject({ errorFirst: { const: true }, failure, success })
const resourceEvents = strictObject({ eventSchemaId: id, terminalEvent: id })
const facadeDelivery: JsonSchema = {
  oneOf: [
    strictObject({
      callback,
      immediateResultSchemaId: id,
      invocationModes: stringSetSchema({ enum: ['callback', 'promise', 'sync'] }, 1, 3),
      kind: { const: 'invocation' },
      resourceEvents
    }, ['invocationModes', 'kind']),
    strictObject({ eventSchemaId: id, kind: { const: 'resourceEvents' }, terminalEvent: id })
  ]
}

export const CORE_CONTRACT_V1_SCHEMA = Object.freeze({
  $defs: {
    facadeDelivery,
    facadeDeliveryRegistry: {
      additionalProperties: false,
      properties: Object.fromEntries(
        Object.keys(FACADE_DELIVERY_REGISTRY_V1)
          .map(name => [name, { const: FACADE_DELIVERY_REGISTRY_V1[name] }])
      ),
      required: Object.keys(FACADE_DELIVERY_REGISTRY_V1),
      type: 'object'
    },
    operationSchemaOwners: {
      items: strictObject({
        owner: id,
        roles: stringSetSchema({ enum: ['args', 'delivery', 'event', 'resource', 'result', 'tuple'] }, 1, 6),
        schema: {},
        schemaId: id
      }),
      maxItems: OPERATION_SCHEMA_OWNER_REGISTRY_V1.length,
      minItems: OPERATION_SCHEMA_OWNER_REGISTRY_V1.length,
      type: 'array'
    }
  },
  $id: 'https://oneworks.ai/holonomy/contracts/core-contract-v1.schema.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema'
})
