import { canonicalJson } from './canonical-json.js'
import { FACADE_DELIVERY_REGISTRY_V1 } from './facade-delivery.js'
import { OPERATION_ARGUMENT_SCHEMAS_V1 } from './registry-argument-schemas.js'
import { REGISTRY_EVENT_SCHEMAS_V1 } from './registry-event-schemas.js'
import { OPERATION_RESOURCE_SCHEMAS_V1 } from './registry-resource-schemas.js'
import { OPERATION_RESULT_SCHEMAS_V1 } from './registry-result-schemas.js'
import type { JsonSchema } from './schema-primitives.js'

export type OperationSchemaRoleV1 = 'args' | 'delivery' | 'event' | 'resource' | 'result' | 'tuple'

export interface OperationSchemaOwnerV1 {
  readonly owner: string
  readonly roles: readonly OperationSchemaRoleV1[]
  readonly schema: JsonSchema
  readonly schemaId: string
}

const owners = new Map<string, OperationSchemaOwnerV1>()
const register = (
  role: OperationSchemaRoleV1,
  owner: string,
  schemas: Readonly<Record<string, JsonSchema>>
) => {
  for (const [schemaId, schema] of Object.entries(schemas)) {
    const existing = owners.get(schemaId)
    if (existing != null) {
      if (canonicalJson(existing.schema as never) !== canonicalJson(schema as never)) {
        throw new Error(`Conflicting operation schema owner ${schemaId}`)
      }
      owners.set(
        schemaId,
        Object.freeze({
          ...existing,
          roles: Object.freeze([...existing.roles, role].sort())
        })
      )
      continue
    }
    owners.set(
      schemaId,
      Object.freeze({
        owner,
        roles: Object.freeze([role]),
        schema: Object.freeze(schema),
        schemaId
      })
    )
  }
}

register('args', 'OperationArgumentSchemasV1', OPERATION_ARGUMENT_SCHEMAS_V1)
register(
  'delivery',
  'FacadeDeliveryRegistryV1',
  Object.fromEntries(
    Object.entries(FACADE_DELIVERY_REGISTRY_V1).map(([schemaId, value]) => [
      schemaId,
      { const: value }
    ])
  )
)
register('resource', 'CanonicalResourceSchemasV1', OPERATION_RESOURCE_SCHEMAS_V1)
register('result', 'OperationResultSchemasV1', OPERATION_RESULT_SCHEMAS_V1)
register(
  'event',
  'RegistryEventSchemasV1',
  Object.fromEntries(
    Object.entries(REGISTRY_EVENT_SCHEMAS_V1).filter(([schemaId]) => !schemaId.endsWith('TupleV1'))
  )
)
register(
  'tuple',
  'RegistryEventSchemasV1',
  Object.fromEntries(
    Object.entries(REGISTRY_EVENT_SCHEMAS_V1).filter(([schemaId]) => schemaId.endsWith('TupleV1'))
  )
)

export const OPERATION_SCHEMA_OWNER_REGISTRY_V1: readonly OperationSchemaOwnerV1[] = Object.freeze(
  [...owners.values()].sort((left, right) => left.schemaId.localeCompare(right.schemaId))
)

export const operationSchemaOwnerV1 = (schemaId: string): OperationSchemaOwnerV1 | undefined => owners.get(schemaId)

export const OPERATION_SCHEMA_IDS_V1 = Object.freeze(
  OPERATION_SCHEMA_OWNER_REGISTRY_V1.map(item => item.schemaId)
)
