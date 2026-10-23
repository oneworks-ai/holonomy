import { normalizeNetworkRedirectInvocationV1 } from '@holonomyjs/capability-network/kernel/network-invocation'
import type { CapabilityBrokerInvocationV1 } from './broker-types.js'
import { CapabilityInvocationError } from './errors.js'
import { bindInvocationAbortSignalV1 } from './invocation-abort.js'
import { exactInvocationInputV1 } from './invocation-input.js'
import { routeCapabilityInvocationV1 } from './invocation-routing.js'
import { trustedInvocationValueFromJsonV1 } from './json-invocation-value.js'
import type { JsonValueV1 } from './json-types.js'
import type { CanonicalResourceV1 } from './resource-types.js'

interface RequestOwnerV1 {
  readonly generation: number
  readonly networkProvider: 'host.network' | 'host.network.mock'
  readonly requestPrefix: string
  readonly nextOrdinal: () => number
  readonly resource: (bindingId: string, type?: string) => CanonicalResourceV1
}

export const createCapabilityInvocationRequestV1 = (
  json: string,
  options: RequestOwnerV1,
  forcedMode?: 'sync',
  signal?: AbortSignal
): CapabilityBrokerInvocationV1 => {
  if (typeof json !== 'string' || json.length > 1024 * 1024) {
    throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
  }
  const input = exactInvocationInputV1(JSON.parse(json), [
    'arguments',
    'bindingId',
    'member',
    'method',
    'mode',
    'module',
    'path',
    'providerData',
    'resourceType',
    'url'
  ])
  const mode = forcedMode ?? input.mode
  if (mode !== 'callback' && mode !== 'promise' && mode !== 'sync') {
    throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
  }
  const module = input.module
  const member = input.member
  if (typeof module !== 'string' || typeof member !== 'string') {
    throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
  }
  const ordinal = options.nextOrdinal()
  const requestId = `${options.requestPrefix}-${options.generation}-${ordinal}`
  // Network snapshots stay closed; cancellation travels only in the invocation context.
  const argumentsValue = bindInvocationAbortSignalV1(
    input.arguments as JsonValueV1,
    signal == null || module === 'web:fetch' || module === 'holo:storage'
      ? undefined
      : `abort-${options.generation}-${ordinal}`,
    options.generation
  )
  const inheritedBindingId = typeof input.bindingId === 'string' ? input.bindingId : undefined
  const routed = inheritedBindingId == null
    ? routeCapabilityInvocationV1({
      arguments: argumentsValue,
      generation: options.generation,
      member,
      method: input.method,
      module,
      networkProvider: options.networkProvider,
      path: input.path,
      requestOrdinal: ordinal,
      url: input.url
    })
    : module === 'web:fetch' && member === 'followRedirect'
    ? (() => {
      const redirect = normalizeNetworkRedirectInvocationV1(input.arguments)
      return { preferredProviderModule: undefined, resource: redirect.toRequest.resource }
    })()
    : {
      preferredProviderModule: undefined,
      resource: options.resource(
        inheritedBindingId,
        typeof input.resourceType === 'string' ? input.resourceType : undefined
      )
    }
  return Object.freeze({
    arguments: trustedInvocationValueFromJsonV1(
      (('argumentsValue' in routed ? routed.argumentsValue : undefined) ?? argumentsValue) as JsonValueV1,
      'argument'
    ),
    ...(inheritedBindingId == null ? {} : { inheritedBindingId }),
    invocationMode: mode,
    member,
    module,
    preferredProviderModule: routed.preferredProviderModule,
    ...(input.providerData === undefined
      ? {}
      : { providerData: trustedInvocationValueFromJsonV1(input.providerData as JsonValueV1, 'argument') }),
    requestId,
    resource: routed.resource,
    ...(signal == null ? {} : { signal })
  })
}
