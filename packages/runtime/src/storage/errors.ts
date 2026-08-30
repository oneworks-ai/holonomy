import { NativeBridgeError } from '../native-port/errors.js'

export type StorageErrorCode =
  | 'storage.authorization_denied'
  | 'storage.cancelled'
  | 'storage.conflict'
  | 'storage.credential_closed'
  | 'storage.disposed'
  | 'storage.internal'
  | 'storage.invalid_argument'
  | 'storage.limit_exceeded'
  | 'storage.not_found'
  | 'storage.not_supported'
  | 'storage.protocol_error'
  | 'storage.sqlite_failed'
  | 'storage.timeout'

export const STORAGE_ERROR_MESSAGES = Object.freeze(
  {
    'storage.authorization_denied': 'Storage operation was not authorized',
    'storage.cancelled': 'Storage operation was cancelled',
    'storage.conflict': 'Storage transaction conflicts with current state',
    'storage.credential_closed': 'Storage credential handle is closed',
    'storage.disposed': 'Storage runtime is disposed',
    'storage.internal': 'Storage provider failed',
    'storage.invalid_argument': 'Storage operation input is invalid',
    'storage.limit_exceeded': 'Storage operation exceeded an authorized limit',
    'storage.not_found': 'Storage value was not found',
    'storage.not_supported': 'Storage operation is not supported',
    'storage.protocol_error': 'Storage provider violated the runtime contract',
    'storage.sqlite_failed': 'SQLite operation failed',
    'storage.timeout': 'Storage operation timed out'
  } as const satisfies Record<StorageErrorCode, string>
)
export class StorageRuntimeError extends Error {
  readonly code: StorageErrorCode
  constructor(code: StorageErrorCode) {
    super(STORAGE_ERROR_MESSAGES[code])
    this.code = code
    this.name = 'StorageRuntimeError'
  }
}
export const createStorageError = (code: StorageErrorCode) => new StorageRuntimeError(code)
export const isStorageErrorCode = (value: unknown): value is StorageErrorCode =>
  typeof value === 'string' && Object.hasOwn(STORAGE_ERROR_MESSAGES, value)
export const mapStorageBridgeError = (error: unknown, operation?: string): StorageRuntimeError => {
  if (error instanceof StorageRuntimeError) return error
  if (!(error instanceof NativeBridgeError)) return createStorageError('storage.internal')
  switch (error.code) {
    case 'cancelled':
      return createStorageError('storage.cancelled')
    case 'timeout':
      return createStorageError('storage.timeout')
    case 'limit_exceeded':
      return createStorageError('storage.limit_exceeded')
    case 'permission_denied':
      return createStorageError('storage.authorization_denied')
    case 'not_found':
      return createStorageError('storage.not_found')
    case 'resource_invalid':
      return operation === 'v1.credential.with-bytes'
        ? createStorageError('storage.credential_closed')
        : createStorageError('storage.disposed')
    case 'disposed':
      return operation === 'v1.credential.with-bytes'
        ? createStorageError('storage.credential_closed')
        : createStorageError('storage.disposed')
    case 'capability_unsupported':
    case 'operation_unsupported':
      return createStorageError('storage.not_supported')
    case 'invalid_request':
    case 'invalid_value':
      return createStorageError('storage.invalid_argument')
    case 'internal':
    case 'protocol_error':
    default:
      return createStorageError('storage.protocol_error')
  }
}
