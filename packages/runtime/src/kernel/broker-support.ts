import type { CapabilityBrokerProviderV1 } from './broker-types.js'
import type { AdmittedRuntimeCreationV1 } from './context-types.js'
import { bindingUnavailable } from './errors.js'
import type { CapabilityInvocationError } from './errors.js'

export const resolveCapabilityProviderV1 = <THostContext>(
  admitted: AdmittedRuntimeCreationV1,
  module: string
): CapabilityBrokerProviderV1<THostContext> => {
  const registration = admitted.hostBindings.providerBindings.find(item => item.module === module)
  if (registration == null) return bindingUnavailable()
  const value = admitted.resolvedHostBindings[registration.providerId]
  if (
    value == null || typeof value !== 'object' ||
    (value as CapabilityBrokerProviderV1).module !== module ||
    !['async', 'sync'].includes((value as CapabilityBrokerProviderV1).execution) ||
    typeof (value as CapabilityBrokerProviderV1).invoke !== 'function'
  ) return bindingUnavailable()
  return value as CapabilityBrokerProviderV1<THostContext>
}

export const createLinkedCapabilitySignalV1 = (runtime: AbortSignal, invocation?: AbortSignal) => {
  const controller = new AbortController()
  const forward = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason)
  }
  const runtimeAbort = () => forward(runtime)
  const invocationAbort = () => {
    if (invocation != null) forward(invocation)
  }
  if (runtime.aborted) forward(runtime)
  else runtime.addEventListener('abort', runtimeAbort, { once: true })
  if (invocation?.aborted === true) forward(invocation)
  else invocation?.addEventListener('abort', invocationAbort, { once: true })
  return Object.freeze({
    abort: (reason: CapabilityInvocationError) => {
      if (!controller.signal.aborted) controller.abort(reason)
    },
    cleanup: () => {
      runtime.removeEventListener('abort', runtimeAbort)
      invocation?.removeEventListener('abort', invocationAbort)
    },
    signal: controller.signal
  })
}
