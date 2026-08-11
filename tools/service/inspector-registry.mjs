import { PROCESS_TERMINAL_STATES } from './constants.mjs'
import { serviceError } from './errors.mjs'
import {
  createOperationRecord,
  getResource,
  newResourceId,
  requireExpectedGeneration,
  touchResource,
  useIdempotency
} from './registry-helpers.mjs'
import { cloneJson, requireEnum, requireRecord } from './validation.mjs'

export const admitInspector = async (context, processId, expectedGeneration, input, idempotencyKey) => {
  const value = requireRecord(input, 'Inspector request')
  const now = context.now()
  return await context.store.transact(
    result => ({
      data: { processId: result.value.inspector.processId, replayed: result.replayed },
      subject: result.value.inspector.id,
      type: 'inspector.admitted'
    }),
    draft => {
      const process = getResource(draft, 'processes', processId, 'Runtime process')
      requireExpectedGeneration(process, expectedGeneration)
      if (PROCESS_TERMINAL_STATES.has(process.state) || !['running', 'waiting_for_debugger'].includes(process.state)) {
        throw serviceError('service.conflict', 'Runtime process is not inspectable')
      }
      if (process.inspectorMode === 'off') {
        throw serviceError('service.precondition_failed', 'Inspector was not enabled for this runtime process')
      }
      return useIdempotency(
        draft,
        {
          key: idempotencyKey,
          scope: `inspector.create:${processId}`,
          value: { expectedGeneration, openDevTools: value.openDevTools === true }
        },
        now,
        context.retentionMs,
        () => createInspectorAdmission(draft, process, now)
      )
    }
  )
}

function createInspectorAdmission(draft, process, now) {
  const inspector = {
    createdAt: now,
    generation: process.generation,
    id: newResourceId('inspector'),
    processId: process.id,
    revision: 1,
    state: 'allocating',
    updatedAt: now
  }
  const operation = createOperationRecord(
    'inspector.open',
    { generation: process.generation, id: inspector.id, type: 'inspector' },
    now
  )
  draft.resources.inspectors[inspector.id] = inspector
  draft.resources.operations[operation.id] = operation
  return { inspector: cloneJson(inspector), operation: cloneJson(operation) }
}

export const updateInspector = async (context, id, state, patch = {}) => {
  const now = context.now()
  return await context.store.transact(
    result => ({ data: { processId: result.processId, state: result.state }, subject: id, type: 'inspector.updated' }),
    draft => {
      const inspector = getResource(draft, 'inspectors', id, 'Inspector lease')
      inspector.state = requireEnum(state, ['allocating', 'closed', 'failed', 'lost', 'ready'], 'Inspector state')
      for (
        const field of [
          'devtoolsFrontendUrl',
          'discoveryUrl',
          'localPort',
          'targetSession',
          'webSocketDebuggerUrl'
        ]
      ) {
        if (patch[field] != null) inspector[field] = cloneJson(patch[field])
      }
      if (['closed', 'failed', 'lost'].includes(state)) inspector.closedAt = now
      touchResource(inspector, now)
      return cloneJson(inspector)
    }
  )
}

export const completeInspectorOpen = async (context, admitted, operationInput, state, patch = {}) => {
  const now = context.now()
  const nextState = requireEnum(state, ['failed', 'ready'], 'Inspector state')
  return await context.store.transact(
    result => ({
      data: { applied: result.applied, processId: admitted.processId, state: nextState },
      subject: admitted.id,
      type: result.applied ? 'inspector.updated' : 'inspector.completion_ignored'
    }),
    draft => {
      const inspector = getResource(draft, 'inspectors', admitted.id, 'Inspector lease')
      const operation = getResource(draft, 'operations', operationInput.id, 'Operation')
      const applied = operation.state === 'running' && operation.target.type === 'inspector' &&
        operation.target.id === admitted.id && operation.target.generation === admitted.generation &&
        inspector.processId === admitted.processId && inspector.generation === admitted.generation &&
        inspector.revision === admitted.revision && inspector.state === admitted.state
      if (!applied) return { applied: false, inspector: cloneJson(admitted) }
      inspector.state = nextState
      for (
        const field of [
          'devtoolsFrontendUrl',
          'discoveryUrl',
          'localPort',
          'targetSession',
          'webSocketDebuggerUrl'
        ]
      ) {
        if (patch[field] != null) inspector[field] = cloneJson(patch[field])
      }
      if (nextState === 'failed') inspector.closedAt = now
      touchResource(inspector, now)
      return { applied: true, inspector: cloneJson(inspector) }
    }
  )
}
