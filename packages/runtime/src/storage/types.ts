import type { NativeBridge, NativeJsonValue, NativeResourceHandle } from '../native-port/types.js'

export type StorageCapability =
  | 'credential.open'
  | 'credential.use'
  | 'kv.delete'
  | 'kv.get'
  | 'kv.list'
  | 'kv.set'
  | 'sqlite.execute'
  | 'sqlite.query'
  | 'sqlite.transaction'

export interface StorageLimits {
  maxDatabaseNameBytes: number
  maxKeyBytes: number
  maxKeysPerList: number
  maxRowsPerQuery: number
  maxSqlBytes: number
  maxTransactionStatements: number
  maxValueBytes: number
}

export interface StorageAuthorityInput {
  capabilities: readonly string[]
  limits?: Partial<StorageLimits>
  namespace: string
  operations: readonly StorageCapability[]
  principal: string
}

export interface StorageAuthority {
  readonly capabilities: readonly string[]
  readonly limits: Readonly<StorageLimits>
  readonly namespace: string
  readonly operations: readonly StorageCapability[]
  readonly principal: string
}

export interface StorageCallOptions {
  deadlineMs?: number
  signal?: AbortSignal
  timeoutMs?: number
}

export type StorageSqlValue = boolean | null | number | string
export type StorageRow = Readonly<Record<string, StorageSqlValue>>

export interface StorageStatement {
  params?: readonly StorageSqlValue[]
  sql: string
}

export interface StorageExecuteResult {
  readonly changes: number
}

export interface StorageCredential {
  close(reason?: string): boolean
  withBytes<T>(callback: (bytes: Uint8Array) => T | Promise<T>, options?: StorageCallOptions): Promise<T>
}

export interface StorageFacade {
  credentials: {
    open(reference: string, options?: StorageCallOptions): Promise<StorageCredential>
  }
  kv: {
    delete(key: string, options?: StorageCallOptions): Promise<boolean>
    get(key: string, options?: StorageCallOptions): Promise<Uint8Array | null>
    list(prefix?: string, options?: StorageCallOptions): Promise<readonly string[]>
    set(key: string, value: Uint8Array | ArrayBuffer, options?: StorageCallOptions): Promise<void>
  }
  sqlite: {
    execute(database: string, statement: StorageStatement, options?: StorageCallOptions): Promise<StorageExecuteResult>
    query(database: string, statement: StorageStatement, options?: StorageCallOptions): Promise<readonly StorageRow[]>
    transaction(
      database: string,
      statements: readonly StorageStatement[],
      options?: StorageCallOptions
    ): Promise<readonly StorageExecuteResult[]>
  }
}

export interface StorageFacadeOptions {
  authority: StorageAuthorityInput
  bridge: NativeBridge
}

export type StorageProviderValue = NativeJsonValue
export type StorageCredentialHandle = NativeResourceHandle
