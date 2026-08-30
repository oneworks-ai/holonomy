import { assertStorageCapability, createStorageAuthority, snapshotStorageRecord } from './authority.js'
import { STORAGE_CREDENTIAL_RESOURCE, STORAGE_OPERATIONS } from './constants.js'
import { StorageCredentialController } from './credential.js'
import { createStorageError, mapStorageBridgeError } from './errors.js'
import { StorageNativeClient } from './native-client.js'
import { requestStorageUnary } from './unary.js'
import {
  assertStorageVoidResult,
  closeStorageResources,
  copyStorageBinary,
  parseStorageExecuteResult,
  parseStorageRow,
  storageByteLength,
  validateStorageDatabase,
  validateStorageKey,
  validateStorageStatement,
  validateStorageStatements
} from './validation.js'

import type {
  StorageAuthority,
  StorageCallOptions,
  StorageFacade,
  StorageFacadeOptions,
  StorageStatement
} from './types.js'

class StorageFacadeController implements StorageFacade {
  readonly credentials: StorageFacade['credentials']
  readonly kv: StorageFacade['kv']
  readonly sqlite: StorageFacade['sqlite']
  readonly #authority: Readonly<StorageAuthority>
  readonly #client: StorageNativeClient

  constructor(options: StorageFacadeOptions) {
    const input = snapshotStorageRecord(options, ['authority', 'bridge'], ['authority', 'bridge'])
    this.#authority = createStorageAuthority(input.authority as StorageFacadeOptions['authority'])
    this.#client = new StorageNativeClient(input.bridge as StorageFacadeOptions['bridge'])
    this.credentials = Object.freeze({ open: (reference, options) => this.openCredential(reference, options) })
    this.kv = Object.freeze({
      delete: (key, options) => this.kvDelete(key, options),
      get: (key, options) => this.kvGet(key, options),
      list: (prefix, options) => this.kvList(prefix, options),
      set: (key, value, options) => this.kvSet(key, value, options)
    })
    this.sqlite = Object.freeze({
      execute: (database, statement, options) => this.sqliteExecute(database, statement, options),
      query: (database, statement, options) => this.sqliteQuery(database, statement, options),
      transaction: (database, statements, options) => this.sqliteTransaction(database, statements, options)
    })
    Object.freeze(this)
  }

  private async kvGet(key: string, options: StorageCallOptions = {}) {
    assertStorageCapability(this.#authority, 'kv.get')
    const item = await requestStorageUnary(this.#client, STORAGE_OPERATIONS.kvGet, {
      key: validateStorageKey(key, this.#authority.limits)
    }, options)
    try {
      if (item.envelope.value === null && !item.envelope.binary?.length && !item.envelope.resources?.length) {
        return null
      }
      if (
        item.envelope.value !== true || item.envelope.resources?.length || item.envelope.binary?.length !== 1 ||
        item.envelope.binary[0]?.handle !== 'value'
      ) throw new Error('invalid')
      const value = copyStorageBinary(item.envelope.binary[0].data, this.#authority.limits.maxValueBytes)
      if (value == null) throw new Error('large')
      return value
    } catch {
      closeStorageResources(item.output.resources, 'malformed_storage_result')
      throw createStorageError('storage.protocol_error')
    }
  }

  private async kvSet(key: string, value: Uint8Array | ArrayBuffer, options: StorageCallOptions = {}) {
    assertStorageCapability(this.#authority, 'kv.set')
    const data = copyStorageBinary(value, this.#authority.limits.maxValueBytes)
    if (data == null || data.byteLength > this.#authority.limits.maxValueBytes) {
      throw createStorageError('storage.invalid_argument')
    }
    const item = await requestStorageUnary(
      this.#client,
      STORAGE_OPERATIONS.kvSet,
      { key: validateStorageKey(key, this.#authority.limits) },
      options,
      data
    )
    assertStorageVoidResult(item.output, item.envelope.value)
  }

  private async kvDelete(key: string, options: StorageCallOptions = {}) {
    assertStorageCapability(this.#authority, 'kv.delete')
    const item = await requestStorageUnary(this.#client, STORAGE_OPERATIONS.kvDelete, {
      key: validateStorageKey(key, this.#authority.limits)
    }, options)
    if (typeof item.envelope.value !== 'boolean' || item.envelope.binary?.length || item.envelope.resources?.length) {
      closeStorageResources(item.output.resources, 'malformed_storage_result')
      throw createStorageError('storage.protocol_error')
    }
    return item.envelope.value
  }

  private async kvList(prefix = '', options: StorageCallOptions = {}) {
    assertStorageCapability(this.#authority, 'kv.list')
    const item = await requestStorageUnary(this.#client, STORAGE_OPERATIONS.kvList, {
      prefix: validateStorageKey(prefix, this.#authority.limits, true)
    }, options)
    if (
      !Array.isArray(item.envelope.value) || item.envelope.value.length > this.#authority.limits.maxKeysPerList ||
      item.envelope.binary?.length || item.envelope.resources?.length ||
      item.envelope.value.some(key =>
        typeof key !== 'string' || storageByteLength(key) > this.#authority.limits.maxKeyBytes
      )
    ) {
      closeStorageResources(item.output.resources, 'malformed_storage_result')
      throw createStorageError('storage.protocol_error')
    }
    return Object.freeze([...item.envelope.value] as string[])
  }

  private async sqliteExecute(database: string, statement: StorageStatement, options: StorageCallOptions = {}) {
    assertStorageCapability(this.#authority, 'sqlite.execute')
    const item = await requestStorageUnary(this.#client, STORAGE_OPERATIONS.sqliteExecute, {
      database: validateStorageDatabase(database, this.#authority.limits),
      statement: validateStorageStatement(statement, this.#authority.limits)
    }, options)
    return parseStorageExecuteResult(item.output, item.envelope.value)
  }

  private async sqliteQuery(database: string, statement: StorageStatement, options: StorageCallOptions = {}) {
    assertStorageCapability(this.#authority, 'sqlite.query')
    const item = await requestStorageUnary(this.#client, STORAGE_OPERATIONS.sqliteQuery, {
      database: validateStorageDatabase(database, this.#authority.limits),
      statement: validateStorageStatement(statement, this.#authority.limits)
    }, options)
    if (
      !Array.isArray(item.envelope.value) || item.envelope.value.length > this.#authority.limits.maxRowsPerQuery ||
      item.envelope.binary?.length || item.envelope.resources?.length
    ) {
      closeStorageResources(item.output.resources, 'malformed_storage_result')
      throw createStorageError('storage.protocol_error')
    }
    return Object.freeze(item.envelope.value.map(row => parseStorageRow(row, this.#authority.limits)))
  }

  private async sqliteTransaction(
    database: string,
    statements: readonly StorageStatement[],
    options: StorageCallOptions = {}
  ) {
    assertStorageCapability(this.#authority, 'sqlite.transaction')
    const validatedStatements = validateStorageStatements(statements, this.#authority.limits)
    const item = await requestStorageUnary(this.#client, STORAGE_OPERATIONS.sqliteTransaction, {
      database: validateStorageDatabase(database, this.#authority.limits),
      statements: validatedStatements
    }, options)
    if (!Array.isArray(item.envelope.value) || item.envelope.value.length !== validatedStatements.length) {
      closeStorageResources(item.output.resources, 'malformed_storage_result')
      throw createStorageError('storage.protocol_error')
    }
    return Object.freeze(item.envelope.value.map(value => parseStorageExecuteResult(item.output, value)))
  }

  private async openCredential(reference: string, options: StorageCallOptions = {}) {
    assertStorageCapability(this.#authority, 'credential.open')
    const item = await requestStorageUnary(this.#client, STORAGE_OPERATIONS.credentialOpen, {
      reference: validateStorageKey(reference, this.#authority.limits)
    }, options)
    if (
      item.envelope.value !== true || item.envelope.binary?.length || item.envelope.resources?.length !== 1 ||
      item.envelope.resources[0]?.type !== STORAGE_CREDENTIAL_RESOURCE
    ) {
      closeStorageResources(item.output.resources, 'malformed_storage_credential')
      throw createStorageError('storage.protocol_error')
    }
    return Object.freeze(new StorageCredentialController(this.#client, item.envelope.resources[0]))
  }
}

export const createStorageFacade = (options: StorageFacadeOptions): StorageFacade => {
  try {
    return new StorageFacadeController(options)
  } catch (error) {
    throw mapStorageBridgeError(error)
  }
}
