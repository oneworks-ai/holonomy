import { NativeBridgeError } from '../native-port/errors.js'

import type { FsErrorCode, FsOperationName } from './types.js'

const MOBILE_FS_ERROR = Symbol('mobile-fs-error')

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
    ERR_MOBILE_RUNTIME_NOT_SUPPORTED: 'File system API is not supported',
    ETIMEDOUT: 'File system operation timed out',
    EXDEV: 'Cross-authority operation is not permitted'
  } as const satisfies Record<FsErrorCode, string>
)

export class MobileFsError extends Error {
  readonly [MOBILE_FS_ERROR] = true
  readonly code: FsErrorCode
  readonly syscall?: FsOperationName

  constructor(code: FsErrorCode, syscall?: FsOperationName) {
    super(FS_ERROR_MESSAGES[code])
    this.code = code
    this.name = 'MobileFsError'
    if (syscall != null) this.syscall = syscall
  }
}

export const isMobileFsError = (value: unknown): value is MobileFsError =>
  value instanceof MobileFsError && value[MOBILE_FS_ERROR] === true

export const createFsError = (
  code: FsErrorCode,
  syscall?: FsOperationName
) => new MobileFsError(code, syscall)

export const mapNativeBridgeError = (
  error: unknown,
  syscall?: FsOperationName
) => {
  if (isMobileFsError(error)) return error
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
      return createFsError('ERR_MOBILE_RUNTIME_NOT_SUPPORTED', syscall)
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
  throw createFsError('ERR_MOBILE_RUNTIME_NOT_SUPPORTED', syscall)
}
