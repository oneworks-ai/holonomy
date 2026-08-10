import { FS_NATIVE_MODULE, FS_OPERATIONS, FS_OPERATION_VERSION } from './constants.js'
import { createFsError } from './errors.js'

import type { NativeBinary, NativeJsonValue, NativeResourceHandle, NativeResult } from '../native-port/types.js'
import type { FsErrorCode, FsOperationName } from './types.js'

const FS_ERROR_CODES = new Set<FsErrorCode>([
  'EACCES',
  'EBADF',
  'ECANCELED',
  'EEXIST',
  'EINVAL',
  'EIO',
  'EISDIR',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY',
  'EPERM',
  'ERR_MOBILE_RUNTIME_NOT_SUPPORTED',
  'ETIMEDOUT',
  'EXDEV'
])

export const FS_PROVIDER_CONTRACT = Object.freeze({
  module: FS_NATIVE_MODULE,
  operations: Object.freeze({
    [FS_OPERATIONS.access]: Object.freeze({ mode: 'result', permission: 'read' }),
    [FS_OPERATIONS.atomicWriteBegin]: Object.freeze({ mode: 'result', permission: 'write' }),
    [FS_OPERATIONS.atomicWriteChunk]: Object.freeze({ mode: 'result', permission: 'transaction' }),
    [FS_OPERATIONS.atomicWriteCommit]: Object.freeze({ mode: 'result', permission: 'transaction' }),
    [FS_OPERATIONS.chmod]: Object.freeze({ mode: 'result', permission: 'write' }),
    [FS_OPERATIONS.cp]: Object.freeze({ mode: 'result', permission: 'read+write' }),
    [FS_OPERATIONS.handleRead]: Object.freeze({ mode: 'result', permission: 'handle' }),
    [FS_OPERATIONS.handleStat]: Object.freeze({ mode: 'result', permission: 'handle' }),
    [FS_OPERATIONS.handleSync]: Object.freeze({ mode: 'result', permission: 'handle' }),
    [FS_OPERATIONS.handleWrite]: Object.freeze({ mode: 'result', permission: 'handle' }),
    [FS_OPERATIONS.lstat]: Object.freeze({ mode: 'result', permission: 'metadata' }),
    [FS_OPERATIONS.mkdir]: Object.freeze({ mode: 'result', permission: 'write' }),
    [FS_OPERATIONS.open]: Object.freeze({ mode: 'result', permission: 'flags' }),
    [FS_OPERATIONS.readStream]: Object.freeze({ mode: 'stream', permission: 'read' }),
    [FS_OPERATIONS.readlink]: Object.freeze({ mode: 'result', permission: 'read' }),
    [FS_OPERATIONS.readdir]: Object.freeze({ mode: 'result', permission: 'read' }),
    [FS_OPERATIONS.realpath]: Object.freeze({ mode: 'result', permission: 'metadata' }),
    [FS_OPERATIONS.rename]: Object.freeze({ mode: 'result', permission: 'write' }),
    [FS_OPERATIONS.rm]: Object.freeze({ mode: 'result', permission: 'write' }),
    [FS_OPERATIONS.stat]: Object.freeze({ mode: 'result', permission: 'metadata' }),
    [FS_OPERATIONS.symlink]: Object.freeze({ mode: 'result', permission: 'read+write' }),
    [FS_OPERATIONS.watch]: Object.freeze({ mode: 'stream', permission: 'read' })
  }),
  version: FS_OPERATION_VERSION
})

interface FsSuccessEnvelope {
  ok: true
  value?: NativeJsonValue
}

interface FsFailureEnvelope {
  error: { code: FsErrorCode }
  ok: false
}

export type FsResultEnvelope = FsFailureEnvelope | FsSuccessEnvelope
export type FsProviderSuccess = Pick<NativeResult, 'value'>

const isRecord = (value: unknown): value is object => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const ownData = (value: object, key: string) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor != null && descriptor.enumerable && 'value' in descriptor
    ? descriptor.value
    : undefined
}

const hasExactKeys = (value: object, expected: readonly string[]) => {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && keys.every(key => typeof key === 'string' && expected.includes(key))
}

export const fsSuccess = (value?: NativeJsonValue): FsProviderSuccess => ({
  value: value === undefined ? { ok: true } : { ok: true, value }
})

export const fsFailure = (code: FsErrorCode): FsProviderSuccess => ({
  value: { error: { code }, ok: false }
})

export const parseFsResult = (
  result: NativeResult,
  syscall?: FsOperationName
) => {
  const envelope = result.value
  if (!isRecord(envelope)) throw createFsError('EIO', syscall)
  const ok = ownData(envelope, 'ok')
  if (ok === true) {
    if (
      !hasExactKeys(
        envelope,
        ownData(envelope, 'value') === undefined ? ['ok'] : ['ok', 'value']
      )
    ) {
      throw createFsError('EIO', syscall)
    }
    return {
      binary: result.binary,
      resources: result.resources,
      value: ownData(envelope, 'value') as NativeJsonValue | undefined
    }
  }
  if (ok !== false || !hasExactKeys(envelope, ['error', 'ok'])) {
    throw createFsError('EIO', syscall)
  }
  const error = ownData(envelope, 'error')
  if (!isRecord(error) || !hasExactKeys(error, ['code'])) {
    throw createFsError('EIO', syscall)
  }
  const code = ownData(error, 'code')
  if (typeof code !== 'string' || !FS_ERROR_CODES.has(code as FsErrorCode)) {
    throw createFsError('EIO', syscall)
  }
  throw createFsError(code as FsErrorCode, syscall)
}

export const closeResourceHandles = (
  resources: readonly NativeResourceHandle[] | undefined,
  reason: string
) => {
  if (resources == null) return
  const closed = new Set<NativeResourceHandle>()
  for (const resource of resources) {
    if (closed.has(resource)) continue
    closed.add(resource)
    try {
      resource.close(reason)
    } catch { /* bridge owns failure containment */ }
  }
}

/** Ordinary FS calls cannot retain a provider resource grant. */
export const parseFsResultWithoutResources = (
  result: NativeResult,
  syscall?: FsOperationName
) => {
  let resourcesClosed = false
  try {
    const output = parseFsResult(result, syscall)
    if (output.resources?.length) {
      closeResourceHandles(output.resources, 'undeclared_fs_resource')
      resourcesClosed = true
      throw createFsError('EIO', syscall)
    }
    return output
  } catch (error) {
    if (!resourcesClosed) closeResourceHandles(result.resources, 'malformed_fs_result')
    throw error
  }
}

/** The sole resource-bearing FS operation is open; malformed output still closes grants. */
export const parseFsResourceResult = (
  result: NativeResult,
  syscall?: FsOperationName
) => {
  try {
    return parseFsResult(result, syscall)
  } catch (error) {
    closeResourceHandles(result.resources, 'malformed_fs_result')
    throw error
  }
}

export const readSingleBinary = (
  binary: readonly NativeBinary<Uint8Array>[] | undefined,
  syscall?: FsOperationName
) => {
  if (
    binary == null ||
    binary.length !== 1 ||
    binary[0]?.handle !== 'data' ||
    !(binary[0].data instanceof Uint8Array)
  ) {
    throw createFsError('EIO', syscall)
  }
  return new Uint8Array(binary[0].data)
}
