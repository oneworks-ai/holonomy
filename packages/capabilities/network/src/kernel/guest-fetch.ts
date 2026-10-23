import type {
  WebNetworkCapabilityAdmissionV1,
  WebNetworkCapabilityHooksV1,
  WebNetworkCapabilityRequestV1,
  WebNetworkCapabilityResponseV1
} from '@holonomyjs/capability-network/web/types'
import type {
  CapabilityGuestAbortSignalV1,
  CapabilityGuestBridgeV1
} from '@holonomyjs/runtime/kernel/guest-facade-support'
import {
  capabilityResourceFieldsV1,
  createCapabilityRequestV1,
  readCapabilityTerminalV1
} from '@holonomyjs/runtime/kernel/guest-facade-support'
import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'
import { encodeBase64 } from '@holonomyjs/runtime/node-compat/encoding'
import { buildNetworkHeaderViewsV1, buildNetworkInvocationSnapshotV1 } from './network-invocation-builder.js'
import type { NetworkInvocationSnapshotV1 } from './network-invocation-types.js'

export { createUnsupportedCapabilityWebSocketV1 } from '../web/unsupported-websocket.js'

const json = (value: unknown): JsonValueV1 => value as JsonValueV1

const abortSignal = (signal: AbortSignal | undefined): CapabilityGuestAbortSignalV1 | undefined => {
  if (signal == null) return undefined
  return Object.freeze({
    add(listener: () => void) {
      signal.addEventListener('abort', listener, { once: true })
    },
    readAborted: () => signal.aborted,
    remove(listener: () => void) {
      signal.removeEventListener('abort', listener)
    }
  })
}

const snapshot = (request: WebNetworkCapabilityRequestV1): NetworkInvocationSnapshotV1 =>
  buildNetworkInvocationSnapshotV1({
    body: request.body,
    headers: request.headers,
    hop: request.hop,
    label: request.url,
    logicalRequestId: request.logicalRequestId,
    method: request.method,
    url: request.url
  })

const admission = (value: unknown): WebNetworkCapabilityAdmissionV1 => {
  const fields = capabilityResourceFieldsV1(value, 'network.response')
  const source = value as { binding: { generation: number } }
  return Object.freeze({
    bindingId: fields.bindingId,
    generation: source.binding.generation,
    resourceType: 'network.response'
  })
}

const metadataValue = (response: WebNetworkCapabilityResponseV1) => ({
  ...response.metadata,
  generation: response.admission.generation,
  headers: buildNetworkHeaderViewsV1(response.metadata.headers),
  responseId: response.admission.bindingId
})

export const createCapabilityNetworkHooksV1 = (
  bridge: CapabilityGuestBridgeV1,
  options: Readonly<{ requestBodyReaderMaxBytes?: number }> = {}
): WebNetworkCapabilityHooksV1 => {
  const maximum = options.requestBodyReaderMaxBytes ?? 0
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 1024 * 1024) {
    throw new TypeError('Invalid Host request body reader bound')
  }
  return Object.freeze({
    async authorizeRedirect(
      from: WebNetworkCapabilityRequestV1,
      to: WebNetworkCapabilityRequestV1,
      status: 301 | 302 | 303 | 307 | 308,
      current: WebNetworkCapabilityAdmissionV1,
      signal?: AbortSignal
    ) {
      const fromRequest = snapshot(from)
      const toRequest = snapshot(to)
      const rewritten = from.method !== to.method
      const bodyReplay = !rewritten && from.body != null ? 'same-buffered-body' : 'none'
      readCapabilityTerminalV1(
        await bridge.invoke(
          createCapabilityRequestV1(
            'web:fetch',
            'followRedirect',
            'promise',
            json({
              bodyReplay,
              fromHop: from.hop,
              fromRequest,
              logicalRequestId: from.logicalRequestId,
              methodRewritten: rewritten,
              status,
              toHop: to.hop,
              toRequest
            }),
            { bindingId: current.bindingId, resourceType: current.resourceType }
          ),
          abortSignal(signal)
        )
      )
    },
    async authorizeRequest(request: WebNetworkCapabilityRequestV1, signal?: AbortSignal) {
      return admission(readCapabilityTerminalV1(
        await bridge.invoke(
          createCapabilityRequestV1(
            'web:fetch',
            'fetch',
            'promise',
            json(snapshot(request))
          ),
          abortSignal(signal),
          maximum > 0 && request.body != null && request.body.byteLength <= maximum
            ? { networkRequestBodyBase64: encodeBase64(request.body, false) }
            : undefined
        )
      ))
    },
    async authorizeResponse(
      response: WebNetworkCapabilityResponseV1,
      member:
        | 'Response.arrayBuffer'
        | 'Response.bytes'
        | 'Response.clone'
        | 'Response.json'
        | 'Response.metadata'
        | 'Response.text'
    ) {
      const value = readCapabilityTerminalV1(
        await bridge.invoke(createCapabilityRequestV1(
          'web:fetch',
          member,
          member === 'Response.metadata' || member === 'Response.clone' ? 'sync' : 'promise',
          {},
          {
            bindingId: response.admission.bindingId,
            providerData: member === 'Response.metadata' ? metadataValue(response) : {},
            resourceType: response.admission.resourceType
          }
        ))
      )
      return member === 'Response.clone' ? admission(value) : value
    },
    cloneResponse(current: WebNetworkCapabilityAdmissionV1) {
      const invoke = bridge.invokeImmediate ?? bridge.invokeSync
      return admission(readCapabilityTerminalV1(invoke(createCapabilityRequestV1(
        'web:fetch',
        'Response.clone',
        'sync',
        {},
        {
          bindingId: current.bindingId,
          providerData: {},
          resourceType: current.resourceType
        }
      ))))
    },
    releaseResponse(current: WebNetworkCapabilityAdmissionV1) {
      bridge.releaseResource?.(current.bindingId)
    }
  })
}

export const createCapabilityFetchV1 = <T>(fetch: T): T => fetch
