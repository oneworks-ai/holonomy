export type RuntimeAdmissionCodeV1 =
  | 'runtime.binding_unavailable'
  | 'runtime.configuration_invalid'
  | 'runtime.policy_version_unsupported'

export type InternalCapabilityCodeV1 =
  | 'argument.invalid'
  | 'capability.denied'
  | 'middleware.failed'
  | 'middleware.invalid_result'
  | 'middleware.permission_denied'
  | 'middleware.timeout'
  | 'policy.denied'
  | 'provider.connection_refused'
  | 'provider.permission_denied'
  | 'provider.protocol_error'
  | 'provider.quota'
  | 'provider.timeout'
  | 'provider.unavailable'
  | 'resource.byte_limit'
  | 'resource.cross_root'
  | 'resource.event_limit'
  | 'resource.exists'
  | 'resource.handle_limit'
  | 'resource.invalid'
  | 'resource.not_found'
  | 'resource.stale'
  | 'result.invalid'
  | 'runtime.async_required'
  | 'runtime.cancelled'
  | 'runtime.generation_stale'

export type NodeGuestErrorCodeV1 =
  | 'ABORT_ERR'
  | 'EACCES'
  | 'EBADF'
  | 'ECONNREFUSED'
  | 'EEXIST'
  | 'EFBIG'
  | 'EIO'
  | 'EINVAL'
  | 'EMFILE'
  | 'ENOENT'
  | 'ENOSPC'
  | 'ENOSYS'
  | 'EPROTO'
  | 'ERR_ACCESS_DENIED'
  | 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  | 'ERR_INVALID_ARG_VALUE'
  | 'ERR_INVALID_RETURN_VALUE'
  | 'ERR_INVALID_STATE'
  | 'ERR_METHOD_NOT_IMPLEMENTED'
  | 'ERR_OPERATION_FAILED'
  | 'ERR_OPERATION_TIMEOUT'
  | 'ERR_OUT_OF_RANGE'
  | 'ERR_SYSTEM_ERROR'
  | 'ETIMEDOUT'
  | 'EXDEV'

export type HoloGuestErrorCodeV1 =
  | 'holo.already_exists'
  | 'holo.async_required'
  | 'holo.capability_denied'
  | 'holo.connection_refused'
  | 'holo.generation_stale'
  | 'holo.invalid_arguments'
  | 'holo.invalid_result'
  | 'holo.middleware_failed'
  | 'holo.not_found'
  | 'holo.operation_cancelled'
  | 'holo.operation_timeout'
  | 'holo.permission_denied'
  | 'holo.policy_denied'
  | 'holo.protocol_error'
  | 'holo.provider_unavailable'
  | 'holo.resource_exhausted'

export interface GuestErrorMappingV1 {
  readonly childProcess: ChildProcessGuestErrorProjectionV1
  readonly holo: HoloGuestErrorCodeV1
  readonly nodeFs: NodeGuestErrorCodeV1
  readonly nodeSystem: NodeGuestErrorCodeV1
}

export interface ChildProcessGuestErrorProjectionV1 {
  readonly capturedOutput?: NodeGuestErrorCodeV1
  readonly default: NodeGuestErrorCodeV1
  readonly stdinWrite?: NodeGuestErrorCodeV1
}

const row = (
  nodeFs: NodeGuestErrorCodeV1,
  nodeSystem: NodeGuestErrorCodeV1,
  holo: HoloGuestErrorCodeV1,
  childProcess: ChildProcessGuestErrorProjectionV1 = { default: nodeSystem }
): GuestErrorMappingV1 =>
  Object.freeze({
    childProcess: Object.freeze(childProcess),
    holo,
    nodeFs,
    nodeSystem
  })

export const CAPABILITY_ERROR_MAP_V1: Readonly<Record<InternalCapabilityCodeV1, GuestErrorMappingV1>> = Object.freeze({
  'argument.invalid': row('EINVAL', 'ERR_INVALID_ARG_VALUE', 'holo.invalid_arguments', { default: 'EINVAL' }),
  'capability.denied': row('EACCES', 'ERR_ACCESS_DENIED', 'holo.capability_denied', { default: 'EACCES' }),
  'middleware.failed': row('EIO', 'ERR_OPERATION_FAILED', 'holo.middleware_failed', { default: 'EIO' }),
  'middleware.invalid_result': row('EPROTO', 'ERR_INVALID_RETURN_VALUE', 'holo.invalid_result', { default: 'EPROTO' }),
  'middleware.permission_denied': row('EACCES', 'ERR_ACCESS_DENIED', 'holo.permission_denied', { default: 'EACCES' }),
  'middleware.timeout': row('ETIMEDOUT', 'ERR_OPERATION_TIMEOUT', 'holo.operation_timeout', { default: 'ETIMEDOUT' }),
  'policy.denied': row('EACCES', 'ERR_ACCESS_DENIED', 'holo.policy_denied', { default: 'EACCES' }),
  'provider.connection_refused': row('ECONNREFUSED', 'ERR_SYSTEM_ERROR', 'holo.connection_refused', {
    default: 'ECONNREFUSED'
  }),
  'provider.permission_denied': row('EACCES', 'ERR_ACCESS_DENIED', 'holo.permission_denied', { default: 'EACCES' }),
  'provider.protocol_error': row('EPROTO', 'ERR_SYSTEM_ERROR', 'holo.protocol_error', { default: 'EPROTO' }),
  'provider.quota': row('EFBIG', 'ERR_OUT_OF_RANGE', 'holo.resource_exhausted', {
    capturedOutput: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    default: 'ERR_OUT_OF_RANGE',
    stdinWrite: 'EFBIG'
  }),
  'provider.timeout': row('ETIMEDOUT', 'ERR_OPERATION_TIMEOUT', 'holo.operation_timeout', { default: 'ETIMEDOUT' }),
  'provider.unavailable': row('EIO', 'ERR_SYSTEM_ERROR', 'holo.provider_unavailable', { default: 'EIO' }),
  'resource.byte_limit': row('EFBIG', 'ERR_OUT_OF_RANGE', 'holo.resource_exhausted', {
    capturedOutput: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    default: 'ERR_OUT_OF_RANGE',
    stdinWrite: 'EFBIG'
  }),
  'resource.cross_root': row('EXDEV', 'ERR_INVALID_ARG_VALUE', 'holo.invalid_arguments', { default: 'EINVAL' }),
  'resource.event_limit': row('ENOSPC', 'ERR_SYSTEM_ERROR', 'holo.resource_exhausted', { default: 'EMFILE' }),
  'resource.exists': row('EEXIST', 'ERR_INVALID_STATE', 'holo.already_exists'),
  'resource.handle_limit': row('EMFILE', 'ERR_SYSTEM_ERROR', 'holo.resource_exhausted', { default: 'EMFILE' }),
  'resource.invalid': row('EINVAL', 'ERR_INVALID_ARG_VALUE', 'holo.invalid_arguments', { default: 'EINVAL' }),
  'resource.not_found': row('ENOENT', 'ERR_INVALID_STATE', 'holo.not_found', { default: 'ENOENT' }),
  'resource.stale': row('EBADF', 'ERR_INVALID_STATE', 'holo.generation_stale'),
  'result.invalid': row('EPROTO', 'ERR_INVALID_RETURN_VALUE', 'holo.invalid_result', { default: 'EPROTO' }),
  'runtime.async_required': row('ENOSYS', 'ERR_METHOD_NOT_IMPLEMENTED', 'holo.async_required', { default: 'ENOSYS' }),
  'runtime.cancelled': row('ABORT_ERR', 'ABORT_ERR', 'holo.operation_cancelled'),
  'runtime.generation_stale': row('EBADF', 'ERR_INVALID_STATE', 'holo.generation_stale')
})
