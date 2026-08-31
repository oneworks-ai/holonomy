import { snapshotGitRecord } from './authority.js'
import { GIT_NATIVE_MODULE, GIT_OPERATIONS, GIT_OPERATION_VERSION } from './constants.js'
import { createGitError, isGitErrorCode } from './errors.js'

import type { NativeJsonValue, NativeResult } from '../native-port/types.js'
import type { GitErrorCode } from './errors.js'

export const GIT_PROVIDER_CONTRACT = Object.freeze({
  module: GIT_NATIVE_MODULE,
  operations: Object.freeze({
    [GIT_OPERATIONS.clone]: Object.freeze({ capability: 'clone', lock: 'destination', mode: 'stream' }),
    [GIT_OPERATIONS.configGet]: Object.freeze({ capability: 'config.read', lock: 'read', mode: 'result' }),
    [GIT_OPERATIONS.fetch]: Object.freeze({ capability: 'fetch', lock: 'write', mode: 'stream' }),
    [GIT_OPERATIONS.open]: Object.freeze({ capability: 'repository.open', lock: 'read', mode: 'result' }),
    [GIT_OPERATIONS.push]: Object.freeze({ capability: 'push', lock: 'write', mode: 'stream' }),
    [GIT_OPERATIONS.remoteList]: Object.freeze({ capability: 'remote.read', lock: 'read', mode: 'result' }),
    [GIT_OPERATIONS.status]: Object.freeze({ capability: 'status', lock: 'read', mode: 'result' })
  }),
  version: GIT_OPERATION_VERSION
})

export interface GitSuccessEnvelope {
  [key: string]: NativeJsonValue
  ok: true
  value: NativeJsonValue
}

export interface GitFailureEnvelope {
  [key: string]: NativeJsonValue
  error: { [key: string]: NativeJsonValue; code: GitErrorCode }
  ok: false
}

export const gitSuccess = (value: NativeJsonValue): GitSuccessEnvelope => ({ ok: true, value })

export const gitFailure = (code: GitErrorCode, retryable?: boolean): GitFailureEnvelope => ({
  error: retryable == null ? { code } : { code, retryable },
  ok: false
})

export const parseGitEnvelope = (result: NativeResult) => {
  try {
    const envelope = snapshotGitRecord(result.value, ['error', 'ok', 'value'], ['ok'])
    if (envelope.ok === true && Object.hasOwn(envelope, 'value') && !Object.hasOwn(envelope, 'error')) {
      return { resources: result.resources, value: envelope.value as NativeJsonValue }
    }
    if (envelope.ok === false && Object.hasOwn(envelope, 'error') && !Object.hasOwn(envelope, 'value')) {
      const error = snapshotGitRecord(envelope.error, ['code', 'retryable'], ['code'])
      if (isGitErrorCode(error.code) && (!Object.hasOwn(error, 'retryable') || typeof error.retryable === 'boolean')) {
        throw createGitError(error.code)
      }
    }
  } catch (error) {
    if (isGitErrorCode((error as { code?: unknown }).code)) throw error
  }
  throw createGitError('git.protocol_error')
}
