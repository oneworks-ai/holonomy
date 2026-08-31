import { parseStorageEnvelope } from './contract.js'
import { createStorageError } from './errors.js'
import type { StorageNativeClient } from './native-client.js'
import { closeStorageResources } from './validation.js'

import type { NativeArgumentValue } from '../native-port/types.js'
import type { StorageCallOptions } from './types.js'

export const requestStorageUnary = async (
  client: StorageNativeClient,
  operation: string,
  args: Record<string, unknown>,
  options: StorageCallOptions,
  input?: Uint8Array
) => {
  const output = await client.request(
    operation,
    args as NativeArgumentValue,
    options,
    input == null ? undefined : [{ data: input, handle: 'value' }]
  )
  try {
    return { envelope: parseStorageEnvelope(output), output }
  } catch (error) {
    closeStorageResources(output.resources, 'malformed_storage_result')
    if (output.resources?.length || output.binary?.length) throw createStorageError('storage.protocol_error')
    throw error
  }
}
