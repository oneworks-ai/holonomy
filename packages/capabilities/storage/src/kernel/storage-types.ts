export const STORAGE_OPERATIONS_V1 = Object.freeze(
  [
    'storage.kv.delete',
    'storage.kv.get',
    'storage.kv.list',
    'storage.kv.set',
    'storage.sqlite.execute',
    'storage.sqlite.query',
    'storage.sqlite.transaction'
  ] as const
)

export type StorageOperationV1 = typeof STORAGE_OPERATIONS_V1[number]

export const STORAGE_LIMIT_NAMES_V2 = Object.freeze(
  [
    'maxDatabaseNameBytes',
    'maxDatabaseBytes',
    'maxDatabases',
    'maxKeyBytes',
    'maxKeysPerList',
    'maxPendingOperations',
    'maxRowsPerQuery',
    'maxSqlBytes',
    'maxSqlInstructions',
    'maxTransactionStatements',
    'maxValueBytes'
  ] as const
)

export type StorageLimitNameV2 = typeof STORAGE_LIMIT_NAMES_V2[number]
export type StorageLimitsV2 = Readonly<Record<StorageLimitNameV2, number>>

export interface StorageNamespaceV2 {
  readonly databases: readonly string[]
  readonly keyPrefixes: readonly string[]
  readonly namespaceId: string
  readonly operations: readonly StorageOperationV1[]
}

export type StorageSandboxV2 =
  | Readonly<{ access: 'none' }>
  | Readonly<{
    access: 'sandboxed'
    limits: StorageLimitsV2
    namespaces: readonly StorageNamespaceV2[]
  }>
