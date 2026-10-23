import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel/errors'
import { utf8ByteLength } from '@holonomyjs/runtime/kernel/validation'
import {
  normalizeStorageCapabilityConstraintsV1,
  storageConstraintForInvocationV1
} from './storage-capability-constraints.js'
import { storageSelectorDigestV1 } from './storage-resources.js'
import type { StorageKvResourceV1, StorageSqlResourceV1 } from './storage-resources.js'
import type { StorageLimitsV2, StorageOperationV1, StorageSandboxV2 } from './storage-types.js'

const fail = (operation: StorageOperationV1, resource: StorageKvResourceV1 | StorageSqlResourceV1): never => {
  throw new CapabilityInvocationError('resource.invalid', operation, resource.semanticResourceDigest)
}

const denied = (operation: StorageOperationV1, resource: StorageKvResourceV1 | StorageSqlResourceV1): never => {
  throw new CapabilityInvocationError('policy.denied', operation, resource.semanticResourceDigest)
}

const statementWithin = (statement: unknown, limits: StorageLimitsV2): boolean => {
  if (statement == null || typeof statement !== 'object' || Array.isArray(statement)) return false
  const value = statement as { params?: unknown; sql?: unknown }
  if (typeof value.sql !== 'string' || utf8ByteLength(value.sql) > limits.maxSqlBytes) return false
  if (value.params === undefined) return true
  return Array.isArray(value.params) && value.params.length <= limits.maxTransactionStatements &&
    value.params.every(param => typeof param !== 'string' || utf8ByteLength(param) <= limits.maxValueBytes)
}

/** Policy is checked before the Broker acquires any user Middleware snapshot or Provider. */
export const materializeStorageConstraintsV1 = (
  input: Readonly<{
    arguments: unknown
    available: boolean
    operation: StorageOperationV1
    policy: StorageSandboxV2
    resource: StorageKvResourceV1 | StorageSqlResourceV1
  }>
) => {
  const { operation, policy, resource } = input
  if (policy.access !== 'sandboxed') return null
  const namespace = policy.namespaces.find(item => item.namespaceId === resource.namespaceId)
  if (namespace == null || !namespace.operations.includes(operation)) return null
  const args = input.arguments as Record<string, unknown>
  if (args.namespaceId !== resource.namespaceId) return fail(operation, resource)
  let selector: string
  if (operation.startsWith('storage.kv.')) {
    if (resource.kind !== 'storageKv') return fail(operation, resource)
    const expectedSelector = operation === 'storage.kv.list' ? 'prefix' : 'key'
    if (resource.selector !== expectedSelector) return fail(operation, resource)
    const value = args[expectedSelector]
    if (typeof value !== 'string' || resource.selectorDigest !== storageSelectorDigestV1(expectedSelector, value)) {
      return fail(operation, resource)
    }
    if (utf8ByteLength(value) > policy.limits.maxKeyBytes) return denied(operation, resource)
    if (!namespace.keyPrefixes.some(prefix => value.startsWith(prefix))) return null
    if (
      operation === 'storage.kv.set' &&
      (typeof args.valueByteLength !== 'number' || args.valueByteLength > policy.limits.maxValueBytes)
    ) {
      return denied(operation, resource)
    }
    selector = value
  } else {
    if (resource.kind !== 'storageSql' || args.database !== resource.database) return fail(operation, resource)
    const database = resource.database
    if (utf8ByteLength(database) > policy.limits.maxDatabaseNameBytes) return denied(operation, resource)
    if (!namespace.databases.includes(database)) return null
    if (operation === 'storage.sqlite.transaction') {
      if (
        !Array.isArray(args.statements) || args.statements.length > policy.limits.maxTransactionStatements ||
        !args.statements.every(statement => statementWithin(statement, policy.limits))
      ) {
        return denied(operation, resource)
      }
    } else if (!statementWithin(args.statement, policy.limits)) return denied(operation, resource)
    selector = database
  }
  return input.available
    ? normalizeStorageCapabilityConstraintsV1({ ...namespace, limits: policy.limits })
    : storageConstraintForInvocationV1(namespace, policy.limits, operation, selector)
}
