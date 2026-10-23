import { activateNetworkRequestBodyReaderV1 } from '@holonomyjs/capability-network/kernel/request-body-reader'
import type { CapabilityBrokerInvocationV1, HoloInvocationContextV1 } from './broker-types.js'
import { capabilityFailure } from './errors.js'
import type { OperationDescriptorV1 } from './operation-types.js'

/** Host inspection channels are not Provider continuation authority. */
export const capabilityProviderContextV1 = <T>(context: HoloInvocationContextV1<T>): HoloInvocationContextV1<T> => {
  if (context.hostBindings == null) return context
  const providerContext = { ...context }
  delete providerContext.hostBindings
  return Object.freeze(providerContext)
}

export const prepareInvocationHostBindingsV1 = (
  invocation: CapabilityBrokerInvocationV1,
  descriptor: OperationDescriptorV1,
  generation: number,
  signal: AbortSignal,
  onFailure: () => void
) => {
  const bindings = Object.freeze([...(invocation.hostBindings ?? [])])
  const cleanup: (() => void)[] = []
  try {
    if (bindings.length > 1 || bindings.length > 0 && descriptor.operation !== 'network.fetch.request') {
      capabilityFailure('argument.invalid', descriptor.operation)
    }
    if (bindings.length > 0) {
      const body = (invocation.arguments.value as { body?: { sha256?: string } }).body
      for (const binding of bindings) {
        if (binding.generation !== generation) capabilityFailure('argument.invalid', descriptor.operation)
        cleanup.push(activateNetworkRequestBodyReaderV1(binding, invocation.requestId, body?.sha256, signal))
      }
    }
    return Object.freeze({
      bindings,
      close: () => {
        for (const close of cleanup) close()
      }
    })
  } catch (error) {
    for (const close of cleanup) close()
    onFailure()
    throw error
  }
}
