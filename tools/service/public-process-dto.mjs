import { cloneJson } from './validation.mjs'

const copyOptional = (target, source, keys) => {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = cloneJson(source[key])
  }
  return target
}

export const publicProcessDto = process => {
  const effective = process.sandboxPolicyFinalizedGeneration === process.generation
  const result = {
    createdAt: process.createdAt,
    deviceId: process.deviceId,
    entryUrl: process.entryUrl,
    generation: process.generation,
    id: process.id,
    inspectorMode: process.inspectorMode,
    isolation: process.isolation,
    pluginGraphRevision: process.pluginGraphRevision ?? 0,
    revision: process.revision,
    ...(process.capabilityRuntime == null
      ? {}
      : {
        capabilityContextDigest: process.capabilityRuntime.contextDigest,
        capabilityPolicyDigest: process.capabilityRuntime.policyDigest,
        capabilityRuntimeState: 'provider-v1'
      }),
    sandboxPolicyState: effective ? 'effective' : 'pending',
    sessionId: process.sessionId,
    state: process.state,
    target: process.target,
    updatedAt: process.updatedAt
  }
  copyOptional(result, process, ['activeOperationId', 'cleanupPending', 'endedAt', 'exit'])
  if (effective) {
    result.sandboxPolicy = cloneJson(process.sandboxPolicy)
    result.sandboxPolicyDigest = process.sandboxPolicyDigest
  }
  return Object.freeze(result)
}

export const publicOperationDto = operation => {
  const result = copyOptional(
    {
      createdAt: operation.createdAt,
      id: operation.id,
      kind: operation.kind,
      revision: operation.revision,
      state: operation.state,
      target: cloneJson(operation.target),
      updatedAt: operation.updatedAt
    },
    operation,
    ['endedAt', 'error']
  )
  if (operation.result != null) {
    result.result = cloneJson(operation.result)
    if (operation.result.process != null) result.result.process = publicProcessDto(operation.result.process)
  }
  return Object.freeze(result)
}

export const publicProcessAdmissionDto = admission =>
  Object.freeze({
    replayed: admission.replayed,
    value: Object.freeze({
      ...(admission.value.networkRules == null ? {} : { networkRules: cloneJson(admission.value.networkRules) }),
      operation: publicOperationDto(admission.value.operation),
      process: publicProcessDto(admission.value.process)
    })
  })

export const publicProcessRemovalDto = value =>
  Object.freeze({
    process: publicProcessDto(value.process),
    removed: cloneJson(value.removed),
    removedAt: value.removedAt
  })
