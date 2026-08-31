import { STORAGE_OPERATIONS } from './constants.js'
import { parseStorageEnvelope } from './contract.js'
import { createStorageError, mapStorageBridgeError } from './errors.js'
import type { StorageNativeClient } from './native-client.js'
import { closeStorageResources, copyStorageBinary } from './validation.js'

import type { NativeResourceHandle, NativeResult } from '../native-port/types.js'
import type { StorageCallOptions, StorageCredential } from './types.js'

const FILL = Function.prototype.call.bind(Uint8Array.prototype.fill) as (value: Uint8Array, fill: number) => Uint8Array
const clear = (value: Uint8Array | undefined) => {
  try {
    if (value != null) FILL(value, 0)
  } catch {}
}
const clearResultBinary = (result: NativeResult | undefined) => {
  for (const binary of result?.binary ?? []) clear(binary.data as Uint8Array)
}

export class StorageCredentialController implements StorageCredential {
  readonly #client: StorageNativeClient
  readonly #handle: NativeResourceHandle
  constructor(client: StorageNativeClient, handle: NativeResourceHandle) {
    this.#client = client
    this.#handle = handle
  }
  close(reason = 'storage_credential_closed') {
    return this.#handle.close(reason)
  }
  async withBytes<T>(callback: (value: Uint8Array) => T | Promise<T>, options: StorageCallOptions = {}) {
    if (typeof callback !== 'function') throw createStorageError('storage.invalid_argument')
    let output: NativeResult | undefined
    let secret: Uint8Array | undefined
    try {
      output = await this.#client.request(STORAGE_OPERATIONS.credentialWithBytes, { credential: this.#handle }, options)
      const envelope = parseStorageEnvelope(output)
      if (
        envelope.value !== true || envelope.resources?.length || envelope.binary?.length !== 1 ||
        envelope.binary[0]?.handle !== 'secret'
      ) throw createStorageError('storage.protocol_error')
      secret = copyStorageBinary(envelope.binary[0].data, Number.MAX_SAFE_INTEGER)
      if (secret == null) throw createStorageError('storage.protocol_error')
      return await callback(secret)
    } catch (error) {
      throw mapStorageBridgeError(error, STORAGE_OPERATIONS.credentialWithBytes)
    } finally {
      closeStorageResources(output?.resources, 'malformed_storage_credential_output')
      clearResultBinary(output)
      clear(secret)
    }
  }
}
