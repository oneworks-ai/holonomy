import { assertProcessNetworkAuthorityV1 } from './authority.mjs'

export const processNetworkPreflightV1 = ({ authority, context, contracts, generation, policy, port }) => {
  const { CapabilityInvocationError, trustedInvocationValueFromJsonV1 } = contracts
  const resource = context.resource.requested
  if (resource.kind !== 'processNetworkEndpoint') return undefined
  assertProcessNetworkAuthorityV1(context, authority, CapabilityInvocationError)
  if (policy.access !== 'sandboxed' || policy.network.access !== 'restricted') {
    throw new CapabilityInvocationError('policy.denied', context.operation)
  }
  if (typeof port.resolveNetwork !== 'function') {
    throw new CapabilityInvocationError('provider.unavailable', context.operation)
  }
  return port.resolveNetwork({ context, generation, policy }).then(resolution =>
    Object.freeze({
      execute: (resolvedContext, authorities) => {
        const resolvedAuthority = authorities[0]
        if (resolvedAuthority == null) {
          throw new CapabilityInvocationError('provider.protocol_error', context.operation)
        }
        // Resolution adds a subrequest binding. Native ports must bind their
        // private prepared token here, not to the requested-phase digest.
        if (resolution.bindResolvedContext !== undefined) {
          if (typeof resolution.bindResolvedContext !== 'function') {
            throw new CapabilityInvocationError('provider.protocol_error', context.operation)
          }
          const result = resolution.bindResolvedContext(resolvedContext)
          if (result !== undefined) {
            // The hook changes private metadata synchronously, never I/O.
            // Observe an invalid async return without publishing a receipt.
            void Promise.resolve(result).catch(() => undefined)
            throw new CapabilityInvocationError('provider.protocol_error', context.operation)
          }
        }
        return resolvedAuthority.complete(trustedInvocationValueFromJsonV1({
          authorized: true,
          generation: resolvedContext.runtime.generation,
          invocationBindingDigest: resolvedAuthority.invocationBinding.invocationBindingDigest,
          resolution: resolution.receipt,
          semanticResourceDigest: resource.semanticResourceDigest
        }, 'result'))
      },
      ...(typeof resolution.dispose === 'function' ? { dispose: () => resolution.dispose() } : {}),
      requests: Object.freeze([Object.freeze({
        evidence: resolution.evidence,
        reason: 'networkAddress',
        resolved: resource,
        sideEffectCount: 0,
        verify: resolution.verify
      })])
    })
  )
}
