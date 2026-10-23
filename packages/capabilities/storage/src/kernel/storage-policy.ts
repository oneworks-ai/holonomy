import { invalidPolicy } from '@holonomyjs/runtime/kernel/errors'
import {
  array,
  boundedText,
  exact,
  identifier,
  integer,
  literal,
  required,
  utf8ByteLength
} from '@holonomyjs/runtime/kernel/validation'
import { STORAGE_LIMIT_NAMES_V2, STORAGE_OPERATIONS_V1 } from './storage-types.js'
import type { StorageLimitsV2, StorageNamespaceV2, StorageSandboxV2 } from './storage-types.js'

export const STORAGE_LIMIT_MAXIMA_V2: StorageLimitsV2 = Object.freeze({
  maxDatabaseNameBytes: 128,
  maxDatabaseBytes: 32 * 1024 * 1024,
  maxDatabases: 16,
  maxKeyBytes: 1024,
  maxKeysPerList: 1024,
  maxPendingOperations: 128,
  maxRowsPerQuery: 1024,
  maxSqlBytes: 64 * 1024,
  maxSqlInstructions: 10_000_000,
  maxTransactionStatements: 256,
  maxValueBytes: 1024 * 1024
})

const scalarText = (value: unknown, maximumBytes: number, allowEmpty = false): string => {
  const text = boundedText(value, maximumBytes, allowEmpty)
  if (!/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u.test(text)) return invalidPolicy()
  return text
}

const compareCodePoints = (left: string, right: string): number => {
  const a = [...left]
  const b = [...right]
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!
    if (difference !== 0) return difference
  }
  return a.length - b.length
}

const sortedUnique = (values: unknown, minimum: number, maximum: number, item: (value: unknown) => string) => {
  const entries = array(values, minimum, maximum).map(item)
  if (new Set(entries).size !== entries.length) return invalidPolicy()
  return Object.freeze(entries.sort(compareCodePoints))
}

export const normalizeStorageLimitsV2 = (value: unknown): StorageLimitsV2 => {
  const input = exact(value, STORAGE_LIMIT_NAMES_V2)
  const output = Object.fromEntries(STORAGE_LIMIT_NAMES_V2.map(name => [
    name,
    integer(required(input, name), 1, STORAGE_LIMIT_MAXIMA_V2[name])
  ])) as Record<keyof StorageLimitsV2, number>
  return Object.freeze(output)
}

export const normalizeStorageSandboxV2 = (value: unknown): StorageSandboxV2 => {
  const input = exact(value, ['access', 'limits', 'namespaces'])
  const access = literal(required(input, 'access'), ['none', 'sandboxed'] as const)
  if (access === 'none') {
    if (Object.keys(input).length !== 1) return invalidPolicy()
    return Object.freeze({ access })
  }
  const limits = normalizeStorageLimitsV2(required(input, 'limits'))
  const namespaces = array(required(input, 'namespaces'), 1, 64).map(value => {
    const namespace = exact(value, ['databases', 'keyPrefixes', 'namespaceId', 'operations'])
    const operations = sortedUnique(
      required(namespace, 'operations'),
      1,
      STORAGE_OPERATIONS_V1.length,
      item => literal(item, STORAGE_OPERATIONS_V1)
    ) as StorageNamespaceV2['operations']
    const keyPrefixes = sortedUnique(
      required(namespace, 'keyPrefixes'),
      0,
      64,
      item => scalarText(item, limits.maxKeyBytes, true)
    )
    const databases = sortedUnique(
      required(namespace, 'databases'),
      0,
      64,
      item => scalarText(item, limits.maxDatabaseNameBytes)
    )
    if (operations.some(operation => operation.startsWith('storage.kv.')) && keyPrefixes.length === 0) {
      return invalidPolicy()
    }
    if (operations.some(operation => operation.startsWith('storage.sqlite.')) && databases.length === 0) {
      return invalidPolicy()
    }
    return Object.freeze({
      databases,
      keyPrefixes,
      namespaceId: identifier(required(namespace, 'namespaceId'), 128),
      operations
    })
  }).sort((left, right) => compareCodePoints(left.namespaceId, right.namespaceId))
  if (new Set(namespaces.map(item => item.namespaceId)).size !== namespaces.length) return invalidPolicy()
  // Limits are finite and never exceed the existing StorageFacade's default maxima.
  if (utf8ByteLength(JSON.stringify(namespaces)) > 256 * 1024) return invalidPolicy()
  return Object.freeze({ access, limits, namespaces: Object.freeze(namespaces) })
}

export const isStorageScalarTextV1 = (value: unknown, maximumBytes: number, allowEmpty = false): value is string => {
  try {
    scalarText(value, maximumBytes, allowEmpty)
    return true
  } catch {
    return false
  }
}
