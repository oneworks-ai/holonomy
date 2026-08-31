import { NativeBridgeError } from '../native-port/errors.js'

export type GitErrorCode =
  | 'git.authentication_failed'
  | 'git.authorization_denied'
  | 'git.cancelled'
  | 'git.conflict'
  | 'git.credentials_required'
  | 'git.internal'
  | 'git.invalid_argument'
  | 'git.invalid_path'
  | 'git.invalid_remote'
  | 'git.limit_exceeded'
  | 'git.locked'
  | 'git.network_unavailable'
  | 'git.non_fast_forward'
  | 'git.not_repository'
  | 'git.not_supported'
  | 'git.protocol_error'
  | 'git.repository_closed'
  | 'git.repository_not_found'
  | 'git.timeout'
  | 'git.transport_failed'

export const GIT_ERROR_MESSAGES = Object.freeze(
  {
    'git.authentication_failed': 'Git authentication failed',
    'git.authorization_denied': 'Git operation was not authorized',
    'git.cancelled': 'Git operation was cancelled',
    'git.conflict': 'Git repository state conflicts with the requested operation',
    'git.credentials_required': 'Git operation requires an authorized credential reference',
    'git.internal': 'Git provider failed',
    'git.invalid_argument': 'Git operation input is invalid',
    'git.invalid_path': 'Git repository path is invalid or not authorized',
    'git.invalid_remote': 'Git remote is invalid or not authorized',
    'git.limit_exceeded': 'Git operation exceeded an authorized limit',
    'git.locked': 'Git repository is busy',
    'git.network_unavailable': 'Git network transport is unavailable',
    'git.non_fast_forward': 'Git push was rejected as non-fast-forward',
    'git.not_repository': 'Path is not a Git repository',
    'git.not_supported': 'Git operation is not supported',
    'git.protocol_error': 'Git provider violated the runtime contract',
    'git.repository_closed': 'Git repository handle is closed',
    'git.repository_not_found': 'Git repository was not found',
    'git.timeout': 'Git operation timed out',
    'git.transport_failed': 'Git transport failed'
  } as const satisfies Record<GitErrorCode, string>
)

export class GitRuntimeError extends Error {
  readonly code: GitErrorCode

  constructor(code: GitErrorCode) {
    super(GIT_ERROR_MESSAGES[code])
    this.code = code
    this.name = 'GitRuntimeError'
  }
}

export const isGitErrorCode = (value: unknown): value is GitErrorCode =>
  typeof value === 'string' && Object.hasOwn(GIT_ERROR_MESSAGES, value)

export const createGitError = (code: GitErrorCode) => new GitRuntimeError(code)

export const mapGitBridgeError = (error: unknown) => {
  if (error instanceof GitRuntimeError) return error
  if (!(error instanceof NativeBridgeError)) return createGitError('git.internal')
  switch (error.code) {
    case 'cancelled':
      return createGitError('git.cancelled')
    case 'timeout':
      return createGitError('git.timeout')
    case 'limit_exceeded':
      return createGitError('git.limit_exceeded')
    case 'capability_unsupported':
    case 'operation_unsupported':
      return createGitError('git.not_supported')
    case 'permission_denied':
      return createGitError('git.authorization_denied')
    case 'resource_invalid':
    case 'disposed':
      return createGitError('git.repository_closed')
    case 'invalid_request':
    case 'invalid_value':
      return createGitError('git.invalid_argument')
    case 'connection_refused':
    case 'unavailable':
      return createGitError('git.network_unavailable')
    case 'internal':
    case 'protocol_error':
    default:
      return createGitError('git.protocol_error')
  }
}
