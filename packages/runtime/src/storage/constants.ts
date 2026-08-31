export const STORAGE_NATIVE_MODULE = 'host.storage'
export const STORAGE_OPERATION_VERSION = 1
export const STORAGE_REQUIRED_CAPABILITY = 'host.storage.v1'

export const STORAGE_OPERATIONS = Object.freeze({
  credentialOpen: 'v1.credential.open',
  credentialWithBytes: 'v1.credential.with-bytes',
  kvDelete: 'v1.kv.delete',
  kvGet: 'v1.kv.get',
  kvList: 'v1.kv.list',
  kvSet: 'v1.kv.set',
  sqliteExecute: 'v1.sqlite.execute',
  sqliteQuery: 'v1.sqlite.query',
  sqliteTransaction: 'v1.sqlite.transaction'
})

export const STORAGE_CREDENTIAL_RESOURCE = 'storage.credential'

export type StorageProviderOperation = typeof STORAGE_OPERATIONS[keyof typeof STORAGE_OPERATIONS]
