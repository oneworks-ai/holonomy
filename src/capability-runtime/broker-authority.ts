import type { CapabilityProviderAuthorityV1, CapabilityProviderTerminalV1 } from './broker-types.js'
import { isTrustedInvocationValueV1 } from './broker-values.js'
import type { TrustedInvocationValueV1 } from './broker-values.js'
import { canonicalDigest } from './canonical-json.js'
import { bindInvocationResource } from './canonical-process-resources.js'
import type { CapabilitySelectionV1 } from './capability-types.js'
import { CapabilityInvocationError, capabilityFailure } from './errors.js'
import type { OperationDescriptorV1 } from './operation-types.js'
import type { CanonicalResourceV1 } from './resource-types.js'

export const createProviderAuthorityV1 = (
  input: Readonly<{
    descriptor: OperationDescriptorV1
    generation: number
    processId: string
    providerModule: string
    requestId: string
    resource: CanonicalResourceV1
    selection: CapabilitySelectionV1
    signal: AbortSignal
  }>
) => {
  const bindings = input.selection.authorityBindings.filter(item => item.providerModule === input.providerModule)
  if (bindings.length === 0 || bindings.length !== input.selection.authorityBindings.length) {
    capabilityFailure('capability.denied', input.descriptor.operation, input.resource.semanticResourceDigest)
  }
  const authorityDigest = canonicalDigest([
    'providerAuthority',
    input.providerModule,
    bindings.map(item => item.authorityDigest).sort()
  ])
  const capabilityBindingDigest = canonicalDigest([
    'capabilitySelection',
    input.selection.branchId,
    input.selection.bindings.map(item => item.digest).sort()
  ])
  const invocationBinding = bindInvocationResource({
    authorityDigest,
    capabilityBindingDigest,
    generation: input.generation,
    operation: input.descriptor.operation,
    processId: input.processId,
    requestId: input.requestId,
    semanticResourceDigest: input.resource.semanticResourceDigest
  })
  const terminals = new WeakSet<object>()
  let completed = false
  const authority: CapabilityProviderAuthorityV1 = Object.freeze({
    bindings,
    complete: (result: TrustedInvocationValueV1, resources = []) => {
      if (input.signal.aborted) {
        const reason = input.signal.reason
        if (reason instanceof CapabilityInvocationError) throw reason
        capabilityFailure('runtime.cancelled', input.descriptor.operation, input.resource.semanticResourceDigest)
      }
      if (completed) {
        capabilityFailure('provider.protocol_error', input.descriptor.operation, input.resource.semanticResourceDigest)
      }
      if (!isTrustedInvocationValueV1(result, 'result')) {
        capabilityFailure('provider.protocol_error', input.descriptor.operation, input.resource.semanticResourceDigest)
      }
      const terminal = Object.freeze({
        receipt: Object.freeze({
          authorityDigest,
          invocationBindingDigest: invocationBinding.invocationBindingDigest,
          providerModule: input.providerModule
        }),
        ...(resources.length === 0 ? {} : { resources: Object.freeze([...resources]) }),
        result
      })
      completed = true
      terminals.add(terminal)
      return terminal
    },
    invocationBinding,
    providerModule: input.providerModule
  })
  return Object.freeze({
    authority,
    owns(terminal: CapabilityProviderTerminalV1): boolean {
      return terminals.has(terminal) &&
        terminal.receipt.authorityDigest === authorityDigest &&
        terminal.receipt.invocationBindingDigest === invocationBinding.invocationBindingDigest &&
        terminal.receipt.providerModule === input.providerModule
    }
  })
}
