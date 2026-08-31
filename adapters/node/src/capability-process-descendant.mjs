import { Buffer } from 'node:buffer'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { CapabilityInvocationError, trustedInvocationValueFromJsonV1 } from '../../../dist/capability-runtime/index.js'

import { assertNodeProcessAuthorityV1 } from './capability-provider-authority.mjs'

export const authorizeNodeProcessDescendantV1 = ({
  authority,
  context,
  manifest,
  policy,
  profile,
  resource,
  resources
}) => {
  if (resource.kind !== 'processExecutable' || resource.invocation !== 'program') {
    throw new CapabilityInvocationError('resource.invalid', context.operation)
  }
  if (policy.access !== 'sandboxed') {
    throw new CapabilityInvocationError('policy.denied', context.operation)
  }
  assertNodeProcessAuthorityV1(context, authority, resource.executableId)
  const executable = manifest.get(resource.executableId)
  const args = context.arguments
  const source = context.source
  if (
    executable == null || executable.shell === true || executable.executable.kind !== 'guestPath' ||
    executable.executable.path !== args.path || source?.kind !== 'linuxProcess' ||
    !manifest.has(source.executableId) ||
    source.linuxPid !== args.linuxPid || source.processStartTimeTicks !== args.processStartTimeTicks ||
    source.rootLinuxPid == null || source.environmentId !== args.environmentId ||
    source.parentLinuxPid !== args.parentLinuxPid || resource.environmentScope !== args.environmentScope ||
    !profile.environment.allowedScopes.includes(resource.environmentScope)
  ) throw new CapabilityInvocationError('policy.denied', context.operation)
  const executablePolicy = policy.executables.find(item => item.executableId === resource.executableId)
  const argumentBytes = args.argv.slice(1).reduce((sum, value) => sum + Buffer.byteLength(value), 0)
  if (executablePolicy == null || argumentBytes > executablePolicy.argumentBytes) {
    throw new CapabilityInvocationError('policy.denied', context.operation)
  }
  resources.reserveDescendant(context)
  return authority.complete(trustedInvocationValueFromJsonV1({
    authorized: true,
    generation: context.runtime.generation,
    invocationBindingDigest: authority.invocationBinding.invocationBindingDigest,
    semanticResourceDigest: resource.semanticResourceDigest
  }, 'result'))
}
