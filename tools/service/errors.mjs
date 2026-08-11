const STATUS_BY_CODE = Object.freeze({
  'process.isolation_unsupported': 501,
  'sandbox.capability_unsupported': 501,
  'service.conflict': 409,
  'service.cursor_expired': 410,
  'service.internal': 500,
  'service.invalid_request': 400,
  'service.limit_exceeded': 413,
  'service.not_found': 404,
  'service.precondition_failed': 409,
  'service.state_corrupt': 500,
  'service.unauthorized': 401,
  'service.unavailable': 503,
  'service.unsupported': 501
})

export const SERVICE_ERROR_CODES = Object.freeze(Object.keys(STATUS_BY_CODE))

export class HolonomyServiceError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'HolonomyServiceError'
    this.code = code
    this.details = options.details
    this.retryable = options.retryable === true
    this.status = options.status ?? STATUS_BY_CODE[code] ?? 500
  }
}

export const serviceError = (code, message, options) => new HolonomyServiceError(code, message, options)

export const normalizeServiceError = error =>
  error instanceof HolonomyServiceError
    ? error
    : serviceError('service.internal', 'The Holonomy service operation failed')

export const publicErrorBody = error => {
  const normalized = normalizeServiceError(error)
  return {
    error: {
      code: normalized.code,
      ...(normalized.details == null ? {} : { details: normalized.details }),
      message: normalized.message,
      retryable: normalized.retryable
    }
  }
}
