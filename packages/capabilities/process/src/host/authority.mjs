const denied = (context, CapabilityInvocationError) => {
  throw new CapabilityInvocationError(
    'capability.denied',
    context.operation,
    context.resource.requested.semanticResourceDigest
  )
}

const bindingsFor = (authority, module) => authority.bindings.filter(binding => binding.providerModule === module)

export const assertProcessAuthorityV1 = (context, authority, executableId, signal, CapabilityInvocationError) => {
  const bindings = bindingsFor(authority, 'host.process')
  if (signal != null) {
    const accepted = bindings.some(binding =>
      binding.capabilityName === 'host.process.signal' && binding.constraints.signals?.includes(signal)
    )
    if (!accepted) denied(context, CapabilityInvocationError)
    return Number.MAX_SAFE_INTEGER
  }
  const execute = bindings.find(binding => binding.capabilityName === 'host.process.execute')
  const accepted = execute != null && bindings.every(binding => {
    const constraints = binding.constraints
    if (binding.capabilityName === 'host.process.execute') {
      return constraints.executableIds?.includes(executableId) && constraints.limits?.maxConcurrentProcesses > 0
    }
    if (binding.capabilityName === 'host.process.shell') return constraints.executableIds?.includes(executableId)
    if (binding.capabilityName === 'host.process.signal') return false
    return false
  })
  if (!accepted) denied(context, CapabilityInvocationError)
  return execute.constraints.limits.maxConcurrentProcesses
}

export const assertProcessNetworkAuthorityV1 = (context, authority, CapabilityInvocationError) => {
  const resource = context.resource.requested
  const accepted = resource.kind === 'processNetworkEndpoint' &&
    bindingsFor(authority, 'host.process').some(binding =>
      binding.capabilityName === 'host.process.network' && binding.constraints.maxSockets > 0 &&
      binding.constraints.endpoints?.some(endpoint =>
        endpoint.hostname === resource.hostname && endpoint.transport === resource.transport &&
        endpoint.ports?.includes(resource.port)
      )
    )
  if (!accepted) denied(context, CapabilityInvocationError)
}
