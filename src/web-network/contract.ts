import type { NativeJsonValue, NativeResourceHandle } from '../native-port/types.js'

import type { WebNetworkErrorCode } from './errors.js'

export const WEB_NETWORK_MODULE = 'host.network'
export const WEB_NETWORK_OPERATION_VERSION = 1

export const WEB_NETWORK_OPERATIONS = Object.freeze({
  http: Object.freeze({
    cancel: 'v1.http.cancel',
    close: 'v1.http.close',
    finishBody: 'v1.http.finish-body',
    openBody: 'v1.http.open-body',
    readBody: 'v1.http.read-body',
    request: 'v1.http.request',
    writeBody: 'v1.http.write-body'
  })
})

/**
 * A long-lived response is the Bridge-issued opaque resource object itself.
 * Network code passes it only as an argument; v4 resolves object identity to a
 * provider-only token and call-token binding before dispatch.
 */
export type NetworkHttpResource = NativeResourceHandle

export interface NetworkSuccessEnvelope<TValue extends NativeJsonValue> {
  [key: string]: NativeJsonValue
  ok: true
  value: TValue
}

export interface NetworkFailureEnvelope {
  [key: string]: NativeJsonValue
  error: WebNetworkErrorCode
  ok: false
}

export type NetworkEnvelope<TValue extends NativeJsonValue> =
  | NetworkFailureEnvelope
  | NetworkSuccessEnvelope<TValue>

export const networkSuccess = <TValue extends NativeJsonValue>(
  value: TValue
): NetworkSuccessEnvelope<TValue> => ({ ok: true, value })

export const networkFailure = (
  error: WebNetworkErrorCode
): NetworkFailureEnvelope => ({ error, ok: false })
