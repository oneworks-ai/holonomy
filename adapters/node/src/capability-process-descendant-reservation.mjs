// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { CapabilityInvocationError } from '../../../dist/capability-runtime/index.js'

export const reserveNodeProcessDescendantV1 = ({
  active,
  context,
  policy,
  total,
  tree
}) => {
  const source = context.source
  const input = context.arguments
  const identities = tree ?? new Map([[source.rootLinuxPid, {
    depth: 1,
    executableId: active.executableId,
    processStartTimeTicks: source.linuxPid === source.rootLinuxPid
      ? source.processStartTimeTicks
      : undefined
  }]])
  let caller = identities.get(input.linuxPid)
  let totalIncrement = 0
  if (caller?.processStartTimeTicks !== input.processStartTimeTicks) {
    if (input.linuxPid === source.rootLinuxPid && caller?.processStartTimeTicks != null) {
      throw new CapabilityInvocationError('resource.stale', context.operation)
    }
    const parent = identities.get(input.parentLinuxPid)
    if (input.linuxPid !== source.rootLinuxPid && parent == null) {
      throw new CapabilityInvocationError('policy.denied', context.operation)
    }
    const depth = input.linuxPid === source.rootLinuxPid ? 1 : parent.depth + 1
    if (
      depth > policy.limits.maxProcessTreeDepth ||
      input.linuxPid !== source.rootLinuxPid && total >= policy.limits.maxTotalProcesses
    ) throw new CapabilityInvocationError('resource.handle_limit', context.operation)
    caller = {
      depth,
      executableId: input.linuxPid === source.rootLinuxPid ? active.executableId : parent.executableId,
      processStartTimeTicks: input.processStartTimeTicks
    }
    identities.set(input.linuxPid, caller)
    if (input.linuxPid !== source.rootLinuxPid) totalIncrement = 1
  }
  if (caller.executableId !== source.executableId) {
    caller = { ...caller, executableId: source.executableId }
    identities.set(input.linuxPid, caller)
  }
  return Object.freeze({ identities, totalIncrement })
}
