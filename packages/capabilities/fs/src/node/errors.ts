import { NativeBridgeError } from '@holonomyjs/runtime/native-port/errors'

import type { FsErrorCode, FsOperationName } from './types.js'

const HOLONOMY_FS_ERROR = Symbol('holonomy-fs-error')

const FS_ERROR_MESSAGES = Object.freeze(
  {
    EACCES: 'File system access was denied',
    EBADF: 'File handle is invalid or closed',
    ECANCELED: 'File system operation was cancelled',
    EEXIST: 'File system entry already exists',
    EINVAL: 'File system operation is invalid',
    EIO: 'File system provider failed',
    EISDIR: 'Expected a file but found a directory',
    ENOENT: 'File system entry does not exist',
    ENOSPC: 'File system quota was exceeded',
    ENOTDIR: 'Expected a directory but found a file',
    ENOTEMPTY: 'Directory is not empty',
    EPERM: 'File system operation is not permitted',
    ERR_HOLONOMY_NOT_SUPPORTED: 'File system API is not supported',
    ETIMEDOUT: 'File system operation timed out',
    EXDEV: 'Cross-authority operation is not permitted'
  } as const satisfies Record<FsErrorCode, string>
)

export class HolonomyFsError extends Error {
  readonly [HOLONOMY_FS_ERROR] = true
  readonly code: FsErrorCode
  readonly syscall?: FsOperationName

  constructor(code: FsErrorCode, syscall?: FsOperationName) {
    super(FS_ERROR_MESSAGES[code])
    this.code = code
    this.name = 'HolonomyFsError'
    if (syscall != null) this.syscall = syscall
  }
}

export const isHolonomyFsError = (value: unknown): value is HolonomyFsError =>
  value instanceof HolonomyFsError && value[HOLONOMY_FS_ERROR] === true

export const createFsError = (
  code: FsErrorCode,
  syscall?: FsOperationName
) => new HolonomyFsError(code, syscall)

export const mapNativeBridgeError = (
  error: unknown,
  syscall?: FsOperationName
) => {
  if (isHolonomyFsError(error)) return error
  if (!(error instanceof NativeBridgeError)) return createFsError('EIO', syscall)
  if (error.domain === 'fs') {
    switch (error.code) {
      case 'exists':
        return createFsError('EEXIST', syscall)
      case 'not_found':
        return createFsError('ENOENT', syscall)
      case 'permission_denied':
        return createFsError('EACCES', syscall)
    }
  }
  switch (error.code) {
    case 'cancelled':
      return createFsError('ECANCELED', syscall)
    case 'timeout':
      return createFsError('ETIMEDOUT', syscall)
    case 'limit_exceeded':
      return createFsError('ENOSPC', syscall)
    case 'capability_unsupported':
    case 'operation_unsupported':
      return createFsError('ERR_HOLONOMY_NOT_SUPPORTED', syscall)
    case 'disposed':
    case 'resource_invalid':
      return createFsError('EBADF', syscall)
    case 'invalid_request':
    case 'invalid_value':
      return createFsError('EINVAL', syscall)
    case 'internal':
    case 'protocol_error':
      return createFsError('EIO', syscall)
    default:
      return createFsError('EIO', syscall)
  }
}

export const notSupported = (syscall?: FsOperationName): never => {
  throw createFsError('ERR_HOLONOMY_NOT_SUPPORTED', syscall)
}
