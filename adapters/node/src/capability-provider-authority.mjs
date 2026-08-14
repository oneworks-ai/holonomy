// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { CapabilityInvocationError } from '../../../dist/capability-runtime/index.js'

const denied = (context) => {
  throw new CapabilityInvocationError(
    'capability.denied',
    context.operation,
    context.resource.requested.semanticResourceDigest
  )
}

const bindingsFor = (authority, module) => authority.bindings.filter(binding => binding.providerModule === module)

export const assertNodeSystemAuthorityV1 = (context, authority) => {
  const resource = context.resource.requested
  const accepted = bindingsFor(authority, 'host.system').some(binding => {
    const constraints = binding.constraints
    return constraints.fields?.includes(resource.field) && constraints.modes?.length > 0
  })
  if (!accepted) denied(context)
}

export const assertNodeDeviceAuthorityV1 = (context, authority) => {
  const resource = context.resource.requested
  const accepted = bindingsFor(authority, 'host.device').some(binding => {
    const constraints = binding.constraints
    return constraints.operations?.includes(resource.operation) &&
      Number.isInteger(constraints.maxPrivacyTier) &&
      resource.privacyTier <= constraints.maxPrivacyTier
  })
  if (!accepted) denied(context)
}

export const assertNodeNetworkAuthorityV1 = (context, authority, module) => {
  const resource = context.resource.requested
  const expectedMode = module === 'host.network.mock' ? 'mockOnly' : 'restricted'
  const scheme = new URL(resource.origin).protocol.slice(0, -1)
  const accepted = bindingsFor(authority, module).some(binding => {
    const constraints = binding.constraints
    return constraints.mode === expectedMode && constraints.origins?.includes(resource.origin) &&
      constraints.schemes?.includes(scheme)
  })
  if (!accepted) denied(context)
}

export const assertNodeProcessAuthorityV1 = (context, authority, executableId, signal) => {
  const bindings = bindingsFor(authority, 'host.process')
  if (signal != null) {
    const accepted = bindings.some(binding =>
      binding.capabilityName === 'host.process.signal' && binding.constraints.signals?.includes(signal)
    )
    if (!accepted) denied(context)
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
  if (!accepted) denied(context)
  return execute.constraints.limits.maxConcurrentProcesses
}

export const assertNodeProcessNetworkAuthorityV1 = (context, authority) => {
  const resource = context.resource.requested
  const accepted = resource.kind === 'processNetworkEndpoint' &&
    bindingsFor(authority, 'host.process').some(binding =>
      binding.capabilityName === 'host.process.network' && binding.constraints.maxSockets > 0 &&
      binding.constraints.endpoints?.some(endpoint =>
        endpoint.hostname === resource.hostname && endpoint.transport === resource.transport &&
        endpoint.ports?.includes(resource.port)
      )
    )
  if (!accepted) denied(context)
}
