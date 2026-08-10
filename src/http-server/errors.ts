import { NativeBridgeError } from '../native-port/errors.js'

export type HttpServerErrorCode =
  | 'ERR_MOBILE_HTTP_ABORTED'
  | 'ERR_MOBILE_HTTP_DISPOSED'
  | 'ERR_MOBILE_HTTP_INVALID_ARGUMENT'
  | 'ERR_MOBILE_HTTP_INVALID_STATE'
  | 'ERR_MOBILE_HTTP_LIMIT_EXCEEDED'
  | 'ERR_MOBILE_HTTP_PERMISSION_DENIED'
  | 'ERR_MOBILE_HTTP_PROTOCOL'
  | 'ERR_MOBILE_HTTP_UNSUPPORTED'

const HTTP_SERVER_ERROR_MESSAGES: Readonly<Record<HttpServerErrorCode, string>> = Object.freeze({
  ERR_MOBILE_HTTP_ABORTED: 'HTTP server operation was aborted',
  ERR_MOBILE_HTTP_DISPOSED: 'HTTP server runtime is disposed',
  ERR_MOBILE_HTTP_INVALID_ARGUMENT: 'HTTP server argument is invalid',
  ERR_MOBILE_HTTP_INVALID_STATE: 'HTTP server state does not allow this operation',
  ERR_MOBILE_HTTP_LIMIT_EXCEEDED: 'HTTP server resource limit was exceeded',
  ERR_MOBILE_HTTP_PERMISSION_DENIED: 'HTTP server operation was denied',
  ERR_MOBILE_HTTP_PROTOCOL: 'HTTP server provider violated the runtime contract',
  ERR_MOBILE_HTTP_UNSUPPORTED: 'HTTP server feature is not supported'
})

export class HttpServerError extends Error {
  constructor(readonly code: HttpServerErrorCode) {
    super(HTTP_SERVER_ERROR_MESSAGES[code])
    this.name = 'HttpServerError'
  }
}

export const createHttpServerError = (code: HttpServerErrorCode) => new HttpServerError(code)

export const mapHttpServerBridgeError = (error: unknown) => {
  if (!(error instanceof NativeBridgeError)) return createHttpServerError('ERR_MOBILE_HTTP_PROTOCOL')
  if (error.code === 'cancelled') return createHttpServerError('ERR_MOBILE_HTTP_ABORTED')
  if (error.code === 'disposed') return createHttpServerError('ERR_MOBILE_HTTP_DISPOSED')
  if (error.code === 'capability_unsupported' || error.code === 'permission_denied') {
    return createHttpServerError('ERR_MOBILE_HTTP_PERMISSION_DENIED')
  }
  if (error.code === 'limit_exceeded') return createHttpServerError('ERR_MOBILE_HTTP_LIMIT_EXCEEDED')
  if (error.code === 'operation_unsupported') {
    return createHttpServerError('ERR_MOBILE_HTTP_UNSUPPORTED')
  }
  if (error.code === 'invalid_request' || error.code === 'invalid_value') {
    return createHttpServerError('ERR_MOBILE_HTTP_INVALID_ARGUMENT')
  }
  if (error.code === 'resource_invalid') return createHttpServerError('ERR_MOBILE_HTTP_INVALID_STATE')
  return createHttpServerError('ERR_MOBILE_HTTP_PROTOCOL')
}
