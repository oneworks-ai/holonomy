import { serviceError } from './errors.mjs'
import { createTargetAdapter } from './target-adapters.mjs'

const unsupported = operation => async () => {
  throw serviceError('service.unsupported', `ADB operation ${operation} is not configured`)
}

const METHODS = Object.freeze([
  'applyNetworkRules',
  'close',
  'closeInspector',
  'exposeFixture',
  'listDevices',
  'listEmulators',
  'openInspector',
  'readLogs',
  'reconcileProcess',
  'removeProcess',
  'removeNetworkRules',
  'restartEmulator',
  'resumeProcess',
  'startProcess',
  'startEmulator',
  'stopEmulator',
  'stopProcess',
  'subscribeProcess'
])

export const createAdbPort = (implementation = {}) =>
  createTargetAdapter(
    'android',
    Object.fromEntries(
      METHODS.map(method => [
        method,
        implementation[method] ?? (
          method === 'close'
            ? async () => undefined
            : method === 'subscribeProcess'
            ? (() => () => undefined)
            : unsupported(method)
        )
      ])
    )
  )

const ADAPTER_ERROR_ALLOWLIST = new Map([
  ['process.isolation_unsupported', { code: 'process.isolation_unsupported', retryable: false }]
])

export const redactAdbFailure = error => (
  ADAPTER_ERROR_ALLOWLIST.get(error?.code) ?? { code: 'service.unavailable', retryable: true }
)

export const redactAdapterFailure = redactAdbFailure
