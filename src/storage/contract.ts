import type { NativeJsonValue, NativeResult } from '../native-port/types.js'
import { snapshotStorageRecord } from './authority.js'
import { STORAGE_NATIVE_MODULE, STORAGE_OPERATIONS, STORAGE_OPERATION_VERSION } from './constants.js'
import { createStorageError, isStorageErrorCode } from './errors.js'

import type { StorageErrorCode, StorageRuntimeError } from './errors.js'

export const STORAGE_PROVIDER_CONTRACT = Object.freeze({
  authority:
    'principal, capabilities and provider namespace allocation travel out-of-band; provider re-authorizes immediately before every operation',
  credentials:
    'credential grants are Bridge-issued storage.credential handles; with-bytes returns one bounded binary value and providers never enumerate or serialize secrets',
  databases:
    'provider owns per-database FIFO; transaction is exclusive and rolls back on every failed/cancelled statement',
  module: STORAGE_NATIVE_MODULE,
  operations: Object.freeze({
    [STORAGE_OPERATIONS.credentialOpen]: Object.freeze({ capability: 'credential.open', mode: 'result' }),
    [STORAGE_OPERATIONS.credentialWithBytes]: Object.freeze({
      capability: 'credential.use',
      mode: 'result',
      resource: 'storage.credential'
    }),
    [STORAGE_OPERATIONS.kvDelete]: Object.freeze({ capability: 'kv.delete', mode: 'result' }),
    [STORAGE_OPERATIONS.kvGet]: Object.freeze({ capability: 'kv.get', mode: 'result' }),
    [STORAGE_OPERATIONS.kvList]: Object.freeze({ capability: 'kv.list', mode: 'result' }),
    [STORAGE_OPERATIONS.kvSet]: Object.freeze({ capability: 'kv.set', mode: 'result' }),
    [STORAGE_OPERATIONS.sqliteExecute]: Object.freeze({ capability: 'sqlite.execute', mode: 'result' }),
    [STORAGE_OPERATIONS.sqliteQuery]: Object.freeze({ capability: 'sqlite.query', mode: 'result' }),
    [STORAGE_OPERATIONS.sqliteTransaction]: Object.freeze({ capability: 'sqlite.transaction', mode: 'result' })
  }),
  version: STORAGE_OPERATION_VERSION
})
export interface StorageSuccessEnvelope {
  [key: string]: NativeJsonValue
  ok: true
  value: NativeJsonValue
}
export interface StorageFailureEnvelope {
  [key: string]: NativeJsonValue
  error: { [key: string]: NativeJsonValue; code: StorageErrorCode }
  ok: false
}
export const storageSuccess = (value: NativeJsonValue): StorageSuccessEnvelope => ({ ok: true, value })
export const storageFailure = (code: StorageErrorCode): StorageFailureEnvelope => ({ error: { code }, ok: false })

/** Only a fully explicit stable failure can escape as its own code. Everything else is protocol_error. */
export const parseStorageEnvelope = (result: NativeResult) => {
  let declaredFailure: StorageRuntimeError | undefined
  try {
    const envelope = snapshotStorageRecord(result.value, ['error', 'ok', 'value'], ['ok'])
    if (envelope.ok === true && Object.hasOwn(envelope, 'value') && !Object.hasOwn(envelope, 'error')) {
      return { binary: result.binary, resources: result.resources, value: envelope.value as NativeJsonValue }
    }
    if (envelope.ok === false && Object.hasOwn(envelope, 'error') && !Object.hasOwn(envelope, 'value')) {
      const error = snapshotStorageRecord(envelope.error, ['code'], ['code'])
      if (isStorageErrorCode(error.code)) {
        declaredFailure = createStorageError(error.code)
        throw declaredFailure
      }
    }
  } catch (error) {
    if (error === declaredFailure) throw error
  }
  throw createStorageError('storage.protocol_error')
}
