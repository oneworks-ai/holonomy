import { PROCESS_TERMINAL_STATES } from './constants.mjs'
import { serviceError } from './errors.mjs'
import { admitLaunchSnapshot } from './launch-admission.mjs'
import { admitNetworkRuleSet } from './network-rule-admission.mjs'
import { createInitialNetworkRules } from './process-initial-network-rules.mjs'
import {
  assertProcessTransition,
  createOperationRecord,
  getResource,
  newResourceId,
  requireExpectedGeneration,
  touchResource,
  useIdempotency
} from './registry-helpers.mjs'
import { assertSandboxNetworkRuleSet, compileSandboxPolicy } from './sandbox-policy.mjs'
import { cloneJson, requireAbsoluteUrl, requireEnum, requireIdentifier, requireRecord } from './validation.mjs'

export const admitProcessStart = async (context, input, idempotencyKey) => {
  const value = requireRecord(input, 'Runtime process request')
  const deviceId = requireIdentifier(value.deviceId, 'Device id')
  const entryUrl = requireAbsoluteUrl(value.entryUrl, 'Runtime entry URL')
  const inspectorMode = requireEnum(value.inspectorMode ?? 'off', ['break', 'enabled', 'off'], 'Inspector mode')
  const isolation = requireEnum(value.isolation, ['isolatedProcess', 'runtime'], 'Runtime isolation')
  const target = requireEnum(value.target, ['android', 'node'], 'Runtime target')
  const launch = admitLaunchSnapshot(value.launch, { entryUrl, target })
  const sandbox = compileSandboxPolicy(value.sandboxPolicy)
  const fixture = value.fixture == null ? undefined : cloneJson(requireRecord(value.fixture, 'Fixture descriptor'))
  if (
    fixture != null &&
    (sandbox.policy.network.access !== 'restricted' || !sandbox.policy.network.allowPrivateNetwork ||
      !sandbox.policy.network.allowedSchemes.includes('http'))
  ) {
    throw serviceError('service.invalid_request', 'The conformance fixture requires restricted network access')
  }
  const initialNetworkRuleSet = value.initialNetworkRuleSet == null
    ? undefined
    : assertSandboxNetworkRuleSet(sandbox.policy, admitNetworkRuleSet(value.initialNetworkRuleSet))
  const admittedInput = {
    deviceId,
    entryUrl,
    ...(fixture == null ? {} : { fixture }),
    ...(initialNetworkRuleSet == null ? {} : { initialNetworkRuleSet }),
    inspectorMode,
    isolation,
    launch,
    sandboxPolicy: sandbox.policy,
    sandboxPolicyDigest: sandbox.digest,
    sandboxPolicyRequested: sandbox.policy,
    target
  }
  const now = context.now()
  return await context.store.transact(
    result => ({ data: { replayed: result.replayed }, subject: result.value.process.id, type: 'process.admitted' }),
    draft =>
      useIdempotency(
        draft,
        {
          key: idempotencyKey,
          scope: 'process.start',
          value: admittedInput
        },
        now,
        context.retentionMs,
        () =>
          createProcessStart(
            draft,
            admittedInput,
            now
          )
      )
  )
}

function createProcessStart(draft, input, now) {
  const device = getResource(draft, 'devices', input.deviceId, 'Device')
  if (device.state !== 'online') throw serviceError('service.conflict', 'Device is not online')
  if (device.platform !== input.target) {
    throw serviceError('service.invalid_request', 'Runtime target does not match the selected device')
  }
  const id = newResourceId('process')
  const operation = createOperationRecord('process.start', { generation: 1, id, type: 'process' }, now)
  const process = {
    activeOperationId: operation.id,
    createdAt: now,
    ...input,
    generation: 1,
    id,
    revision: 1,
    ...(input.fixture == null ? { sandboxPolicyFinalizedGeneration: 1 } : {}),
    sessionId: newResourceId('session'),
    state: 'queued',
    updatedAt: now
  }
  draft.resources.operations[operation.id] = operation
  draft.resources.processes[id] = process
  const networkRules = input.initialNetworkRuleSet == null
    ? undefined
    : createInitialNetworkRules(draft, process, input.initialNetworkRuleSet, now)
  return {
    ...(networkRules == null ? {} : { networkRules: cloneJson(networkRules) }),
    operation: cloneJson(operation),
    process: cloneJson(process)
  }
}

export const admitProcessAction = async (context, kind, id, expectedGeneration, idempotencyKey) => {
  if (!['restart', 'resume', 'stop'].includes(kind)) {
    throw serviceError('service.invalid_request', 'Runtime process action is invalid')
  }
  const now = context.now()
  return await context.store.transact(
    result => ({ data: { kind, replayed: result.replayed }, subject: id, type: `process.${kind}.admitted` }),
    draft => {
      const process = getResource(draft, 'processes', id, 'Runtime process')
      requireExpectedGeneration(process, expectedGeneration)
      return useIdempotency(
        draft,
        { key: idempotencyKey, scope: `process.${kind}:${id}`, value: { expectedGeneration } },
        now,
        context.retentionMs,
        () => createProcessAction(draft, process, kind, now)
      )
    }
  )
}

function createProcessAction(draft, process, kind, now) {
  if (process.state === 'stopping') throw serviceError('service.conflict', 'Runtime process is already stopping')
  if (kind === 'resume' && process.state !== 'waiting_for_debugger') {
    throw serviceError('service.conflict', 'Runtime process is not waiting for a debugger')
  }
  const operation = createOperationRecord(
    `process.${kind}`,
    { generation: process.generation, id: process.id, type: 'process' },
    now
  )
  draft.resources.operations[operation.id] = operation
  process.activeOperationId = operation.id
  if (kind !== 'resume' && !PROCESS_TERMINAL_STATES.has(process.state)) {
    assertProcessTransition(process.state, 'stopping')
    process.state = 'stopping'
  }
  touchResource(process, now)
  return { operation: cloneJson(operation), process: cloneJson(process) }
}

export const beginRestart = async (context, id, expectedGeneration, operationId) => {
  const now = context.now()
  return await context.store.transact(
    result => ({ data: { generation: result.generation }, subject: id, type: 'process.generation.started' }),
    draft => {
      const process = getResource(draft, 'processes', id, 'Runtime process')
      requireExpectedGeneration(process, expectedGeneration)
      if (process.activeOperationId !== operationId) {
        throw serviceError('service.precondition_failed', 'Runtime process operation is stale')
      }
      assertProcessTransition(process.state, 'queued')
      process.generation += 1
      process.sessionId = newResourceId('session')
      process.state = 'queued'
      delete process.sandboxPolicyFinalizedGeneration
      delete process.endedAt
      delete process.exit
      touchResource(process, now)
      return cloneJson(process)
    }
  )
}

export const updateProcess = async (context, id, expectedGeneration, patch) => {
  const value = requireRecord(patch, 'Runtime process update')
  const now = context.now()
  return await context.store.transact(
    result => ({ data: { generation: result.generation, state: result.state }, subject: id, type: 'process.updated' }),
    draft => {
      const process = getResource(draft, 'processes', id, 'Runtime process')
      requireExpectedGeneration(process, expectedGeneration)
      if (value.state != null) {
        assertProcessTransition(process.state, value.state)
        process.state = value.state
        if (PROCESS_TERMINAL_STATES.has(process.state)) process.endedAt = now
      }
      if (value.exit != null) process.exit = cloneJson(requireRecord(value.exit, 'Runtime process exit'))
      if (value.sessionId != null) process.sessionId = requireIdentifier(value.sessionId, 'Session id')
      if (value.activeOperationId === null) delete process.activeOperationId
      touchResource(process, now)
      return cloneJson(process)
    }
  )
}
