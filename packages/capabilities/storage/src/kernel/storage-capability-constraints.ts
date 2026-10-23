import { invalidPolicy } from '@holonomyjs/runtime/kernel/errors'
import { exact, required } from '@holonomyjs/runtime/kernel/validation'
import { normalizeStorageSandboxV2 } from './storage-policy.js'
import type { StorageLimitsV2, StorageNamespaceV2, StorageOperationV1 } from './storage-types.js'

export interface StorageCapabilityConstraintsV1 extends StorageNamespaceV2 {
  readonly limits: StorageLimitsV2
}

export const normalizeStorageCapabilityConstraintsV1 = (value: unknown): StorageCapabilityConstraintsV1 => {
  const input = exact(value, ['databases', 'keyPrefixes', 'limits', 'namespaceId', 'operations'])
  const normalized = normalizeStorageSandboxV2({
    access: 'sandboxed',
    limits: required(input, 'limits'),
    namespaces: [{
      databases: required(input, 'databases'),
      keyPrefixes: required(input, 'keyPrefixes'),
      namespaceId: required(input, 'namespaceId'),
      operations: required(input, 'operations')
    }]
  })
  if (normalized.access !== 'sandboxed') return invalidPolicy()
  return Object.freeze({ ...normalized.namespaces[0]!, limits: normalized.limits })
}

const commonPrefixes = (left: readonly string[], right: readonly string[]) =>
  Object.freeze(
    [...new Set(left.flatMap(a => right.flatMap(b => a.startsWith(b) ? [a] : b.startsWith(a) ? [b] : [])))].sort()
  )

export const meetStorageCapabilityConstraintsV1 = (
  leftValue: unknown,
  rightValue: unknown
): StorageCapabilityConstraintsV1 | null => {
  const left = normalizeStorageCapabilityConstraintsV1(leftValue)
  const right = normalizeStorageCapabilityConstraintsV1(rightValue)
  if (left.namespaceId !== right.namespaceId) return null
  const operations = left.operations.filter(operation => right.operations.includes(operation))
  if (operations.length === 0) return null
  const keyPrefixes = commonPrefixes(left.keyPrefixes, right.keyPrefixes)
  const databases = left.databases.filter(database => right.databases.includes(database))
  if (operations.some(operation => operation.startsWith('storage.kv.')) && keyPrefixes.length === 0) return null
  if (operations.some(operation => operation.startsWith('storage.sqlite.')) && databases.length === 0) return null
  const limits = Object.fromEntries(
    Object.keys(left.limits).map(name => [
      name,
      Math.min(left.limits[name as keyof StorageLimitsV2], right.limits[name as keyof StorageLimitsV2])
    ])
  ) as unknown as StorageLimitsV2
  return normalizeStorageCapabilityConstraintsV1({
    databases,
    keyPrefixes,
    limits,
    namespaceId: left.namespaceId,
    operations
  })
}

const includesAll = <T>(available: readonly T[], required: readonly T[]) =>
  required.every(value => available.includes(value))

export const storageCapabilitySatisfiesV1 = (availableValue: unknown, requiredValue: unknown): boolean => {
  const available = normalizeStorageCapabilityConstraintsV1(availableValue)
  const required = normalizeStorageCapabilityConstraintsV1(requiredValue)
  return available.namespaceId === required.namespaceId &&
    includesAll(available.operations, required.operations) &&
    includesAll(available.databases, required.databases) &&
    required.keyPrefixes.every(prefix => available.keyPrefixes.some(scope => prefix.startsWith(scope))) &&
    Object.keys(required.limits).every(name =>
      available.limits[name as keyof StorageLimitsV2] >= required.limits[name as keyof StorageLimitsV2]
    )
}

export const storageConstraintForInvocationV1 = (
  namespace: StorageNamespaceV2,
  limits: StorageLimitsV2,
  operation: StorageOperationV1,
  selector: string
): StorageCapabilityConstraintsV1 =>
  normalizeStorageCapabilityConstraintsV1({
    databases: operation.startsWith('storage.sqlite.') ? [selector] : [],
    keyPrefixes: operation.startsWith('storage.kv.') ? [selector] : [],
    limits,
    namespaceId: namespace.namespaceId,
    operations: [operation]
  })
