import { PROCESS_TERMINAL_STATES } from './constants.mjs'
import { serviceError } from './errors.mjs'
import { admitNetworkRuleSet } from './network-rule-admission.mjs'
import {
  createOperationRecord,
  getResource,
  newResourceId,
  requireExpectedGeneration,
  touchResource,
  useIdempotency
} from './registry-helpers.mjs'
import { assertSandboxNetworkRuleSet, sandboxDefaultNetworkRuleSet } from './sandbox-policy.mjs'
import { cloneJson, requireEnum } from './validation.mjs'

export const admitNetworkRules = async (
  context,
  processId,
  expectedGeneration,
  ruleSet,
  expectedRuleRevision,
  idempotencyKey
) => {
  const copiedRuleSet = admitNetworkRuleSet(ruleSet)
  const now = context.now()
  return await context.store.transact(
    result => ({
      data: { processId: result.value.networkRules.processId, replayed: result.replayed },
      subject: result.value.networkRules.id,
      type: 'network_rules.admitted'
    }),
    draft => {
      const process = getResource(draft, 'processes', processId, 'Runtime process')
      requireExpectedGeneration(process, expectedGeneration)
      if (PROCESS_TERMINAL_STATES.has(process.state)) {
        throw serviceError('service.conflict', 'Runtime process is terminal')
      }
      assertSandboxNetworkRuleSet(process.sandboxPolicy, copiedRuleSet)
      return useIdempotency(
        draft,
        {
          key: idempotencyKey,
          scope: `network-rules.replace:${processId}`,
          value: { expectedGeneration, expectedRuleRevision, ruleSet: copiedRuleSet }
        },
        now,
        context.retentionMs,
        () => createNetworkRulesAdmission(draft, process, copiedRuleSet, expectedRuleRevision, now)
      )
    }
  )
}

function createNetworkRulesAdmission(draft, process, ruleSet, expectedRuleRevision, now) {
  const existing = Object.values(draft.resources.networkRules).filter(resource => (
    resource.processId === process.id && resource.generation === process.generation
  )).sort((left, right) => Number(right.ruleRevision) - Number(left.ruleRevision))[0]
  const actualRevision = existing?.ruleRevision ?? '0'
  if (expectedRuleRevision !== actualRevision) {
    throw serviceError('service.precondition_failed', 'Network rule revision is stale', {
      details: { actualRevision, expectedRevision: expectedRuleRevision }
    })
  }
  const networkRules = {
    createdAt: existing?.createdAt ?? now,
    generation: process.generation,
    id: existing?.id ?? newResourceId('network_rules'),
    mode: ruleSet.mode,
    processId: process.id,
    revision: (existing?.revision ?? 0) + 1,
    ruleRevision: String(Number(actualRevision) + 1),
    rules: ruleSet.rules,
    state: 'applying',
    updatedAt: now
  }
  delete networkRules.endedAt
  const operation = createOperationRecord(
    'network_rules.replace',
    { generation: process.generation, id: networkRules.id, type: 'networkRules' },
    now
  )
  draft.resources.networkRules[networkRules.id] = networkRules
  draft.resources.operations[operation.id] = operation
  return { networkRules: cloneJson(networkRules), operation: cloneJson(operation) }
}

export const completeNetworkRules = async (context, admitted, operationInput, state) => {
  const now = context.now()
  const nextState = requireEnum(state, ['active', 'failed', 'removed'], 'Network rules state')
  return await context.store.transact(
    result => ({
      data: {
        applied: result.applied,
        processId: result.networkRules.processId,
        ruleRevision: result.networkRules.ruleRevision,
        state: nextState
      },
      subject: admitted.id,
      type: result.applied ? 'network_rules.updated' : 'network_rules.completion_ignored'
    }),
    draft => {
      const resource = getResource(draft, 'networkRules', admitted.id, 'Network rules')
      const operation = getResource(draft, 'operations', operationInput.id, 'Operation')
      const operationMatches = operation.state === 'running' &&
        operation.target.generation === admitted.generation && (
          operation.target.type === 'networkRules'
            ? operation.target.id === admitted.id
            : operation.target.type === 'process' && operation.target.id === admitted.processId
        )
      const applied = operationMatches && resource.state === 'applying' &&
        resource.generation === admitted.generation && resource.ruleRevision === admitted.ruleRevision
      const completed = applied ? resource : cloneJson(admitted)
      completed.state = nextState
      if (nextState === 'failed' || nextState === 'removed') completed.endedAt = now
      touchResource(completed, now)
      return { applied, networkRules: cloneJson(completed) }
    }
  )
}

export const admitNetworkRulesRemove = async (
  context,
  id,
  expectedGeneration,
  expectedRuleRevision,
  idempotencyKey
) => {
  const now = context.now()
  return await context.store.transact(
    result => ({
      data: { processId: result.value.networkRules.processId, replayed: result.replayed },
      subject: id,
      type: 'network_rules.remove_admitted'
    }),
    draft => {
      const networkRules = getResource(draft, 'networkRules', id, 'Network rules')
      const process = getResource(draft, 'processes', networkRules.processId, 'Runtime process')
      requireExpectedGeneration(process, expectedGeneration)
      if (networkRules.ruleRevision !== expectedRuleRevision) {
        throw serviceError('service.precondition_failed', 'Network rule revision is stale')
      }
      return useIdempotency(
        draft,
        {
          key: idempotencyKey,
          scope: `network-rules.remove:${id}`,
          value: { expectedGeneration, expectedRuleRevision }
        },
        now,
        context.retentionMs,
        () => createRemoveAdmission(draft, networkRules, now)
      )
    }
  )
}

function createRemoveAdmission(draft, networkRules, now) {
  if (networkRules.state === 'removed') {
    throw serviceError('service.conflict', 'Network rules are already removed')
  }
  const operation = createOperationRecord(
    'network_rules.remove',
    { generation: networkRules.generation, id: networkRules.id, type: 'networkRules' },
    now
  )
  const process = getResource(draft, 'processes', networkRules.processId, 'Runtime process')
  const empty = sandboxDefaultNetworkRuleSet(process.sandboxPolicy)
  networkRules.mode = empty.mode
  networkRules.revision += 1
  networkRules.ruleRevision = String(Number(networkRules.ruleRevision) + 1)
  networkRules.rules = []
  networkRules.state = 'applying'
  networkRules.updatedAt = now
  draft.resources.operations[operation.id] = operation
  return { networkRules: cloneJson(networkRules), operation: cloneJson(operation) }
}
