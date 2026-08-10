import type { NativePortErrorCode, NativePortErrorDetails, NativePortErrorDomain } from './types.js'

export const NATIVE_PORT_ERROR_MESSAGES = {
  cancelled: 'Native request was cancelled',
  capability_unsupported: 'Native capability is not supported',
  disposed: 'Native bridge is disposed',
  internal: 'Native provider operation failed',
  invalid_request: 'Native request is invalid',
  invalid_value: 'Native value is not JSON-safe',
  limit_exceeded: 'Native bridge resource limit was exceeded',
  not_found: 'Native resource was not found',
  operation_unsupported: 'Native operation is not supported',
  exists: 'Native resource already exists',
  permission_denied: 'Native operation was denied',
  protocol_error: 'Native provider violated the port protocol',
  resource_invalid: 'Native resource handle is invalid or closed',
  connection_refused: 'Native connection was refused',
  timeout: 'Native request timed out',
  unavailable: 'Native service is unavailable'
} as const satisfies Record<NativePortErrorCode, string>

export class NativeBridgeError extends Error {
  readonly code: NativePortErrorCode
  readonly details?: Readonly<NativePortErrorDetails>
  readonly domain: NativePortErrorDomain

  constructor(
    code: NativePortErrorCode,
    domain: NativePortErrorDomain = 'runtime',
    details?: NativePortErrorDetails
  ) {
    super(NATIVE_PORT_ERROR_MESSAGES[code])
    this.code = code
    this.details = details === undefined ? undefined : Object.freeze({ ...details })
    this.domain = domain
    this.name = 'NativeBridgeError'
  }
}

export const createNativeBridgeError = (
  code: NativePortErrorCode,
  domain: NativePortErrorDomain = 'runtime',
  details?: NativePortErrorDetails
) => new NativeBridgeError(code, domain, details)
