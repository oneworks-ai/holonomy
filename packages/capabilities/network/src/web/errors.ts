export type WebNetworkErrorCode =
  | 'network.cancelled'
  | 'network.connection_refused'
  | 'network.dns_failed'
  | 'network.internal'
  | 'network.invalid_url'
  | 'network.not_supported'
  | 'network.offline'
  | 'network.protocol_error'
  | 'network.redirect_limit'
  | 'network.response_too_large'
  | 'network.timeout'
  | 'network.tls_failed'

export const WEB_NETWORK_ERROR_MESSAGES = {
  'network.cancelled': 'Network operation was cancelled',
  'network.connection_refused': 'Network connection was refused',
  'network.dns_failed': 'Network name resolution failed',
  'network.internal': 'Network operation failed',
  'network.invalid_url': 'Network URL is invalid or not authorized',
  'network.not_supported': 'Network operation is not supported',
  'network.offline': 'Network is offline',
  'network.protocol_error': 'Network peer or provider violated the protocol',
  'network.redirect_limit': 'Network redirect policy was exceeded',
  'network.response_too_large': 'Network response exceeded its byte limit',
  'network.timeout': 'Network operation timed out',
  'network.tls_failed': 'Secure network connection failed'
} as const satisfies Record<WebNetworkErrorCode, string>

export class WebNetworkError extends Error {
  readonly code: WebNetworkErrorCode

  constructor(code: WebNetworkErrorCode) {
    super(WEB_NETWORK_ERROR_MESSAGES[code])
    this.code = code
    this.name = 'WebNetworkError'
  }
}

export const createWebNetworkError = (code: WebNetworkErrorCode) => (
  new WebNetworkError(code)
)

export const isWebNetworkErrorCode = (value: unknown): value is WebNetworkErrorCode => (
  typeof value === 'string' && Object.hasOwn(WEB_NETWORK_ERROR_MESSAGES, value)
)
