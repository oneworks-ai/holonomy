import { canonicalDigest } from '@holonomyjs/runtime/kernel/canonical-json'
import { invalidPolicy } from '@holonomyjs/runtime/kernel/errors'
import { identifier } from '@holonomyjs/runtime/kernel/validation'
import { isStorageScalarTextV1 } from './storage-policy.js'

export type StorageKvSelectorV1 = 'key' | 'prefix'

export interface StorageKvResourceV1 {
  readonly display: Readonly<{ label: string }>
  readonly kind: 'storageKv'
  readonly namespaceId: string
  readonly schemaVersion: 1
  readonly selector: StorageKvSelectorV1
  readonly selectorDigest: string
  readonly semanticId: string
  readonly semanticResourceDigest: string
}

export interface StorageSqlResourceV1 {
  readonly database: string
  readonly display: Readonly<{ label: string }>
  readonly kind: 'storageSql'
  readonly namespaceId: string
  readonly schemaVersion: 1
  readonly semanticId: string
  readonly semanticResourceDigest: string
}

const label = (value: unknown): string => {
  if (!isStorageScalarTextV1(value, 256)) return invalidPolicy()
  return value
}

export const storageSelectorDigestV1 = (selector: StorageKvSelectorV1, value: unknown): string => {
  if (selector !== 'key' && selector !== 'prefix') return invalidPolicy()
  if (!isStorageScalarTextV1(value, 1024, selector === 'prefix')) return invalidPolicy()
  return canonicalDigest(['storage.selector', selector, value])
}

export const canonicalizeStorageKvResourceFromDigestV1 = (
  namespaceValue: unknown,
  selector: StorageKvSelectorV1,
  digestValue: unknown,
  displayLabel: unknown
): StorageKvResourceV1 => {
  const namespaceId = identifier(namespaceValue, 128)
  if (selector !== 'key' && selector !== 'prefix') return invalidPolicy()
  if (typeof digestValue !== 'string' || !/^[0-9a-f]{64}$/u.test(digestValue)) return invalidPolicy()
  const selectorDigest = digestValue
  return Object.freeze({
    display: Object.freeze({ label: label(displayLabel) }),
    kind: 'storageKv',
    namespaceId,
    schemaVersion: 1,
    selector,
    selectorDigest,
    semanticId: `storage-kv:${namespaceId}:${selector}:${selectorDigest.slice(0, 16)}`,
    semanticResourceDigest: canonicalDigest(['storageKv', namespaceId, selector, selectorDigest])
  })
}

export const canonicalizeStorageKvResourceV1 = (
  namespaceId: unknown,
  selector: StorageKvSelectorV1,
  rawText: unknown,
  displayLabel: unknown = 'storage KV'
): StorageKvResourceV1 =>
  canonicalizeStorageKvResourceFromDigestV1(
    namespaceId,
    selector,
    storageSelectorDigestV1(selector, rawText),
    displayLabel
  )

export const canonicalizeStorageSqlResourceV1 = (
  namespaceValue: unknown,
  databaseValue: unknown,
  displayLabel: unknown = 'storage SQLite'
): StorageSqlResourceV1 => {
  const namespaceId = identifier(namespaceValue, 128)
  if (!isStorageScalarTextV1(databaseValue, 128)) return invalidPolicy()
  const database = databaseValue
  return Object.freeze({
    database,
    display: Object.freeze({ label: label(displayLabel) }),
    kind: 'storageSql',
    namespaceId,
    schemaVersion: 1,
    semanticId: `storage-sql:${namespaceId}:${database}`,
    semanticResourceDigest: canonicalDigest(['storageSql', namespaceId, database])
  })
}
