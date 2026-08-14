import { normalizeRuntimePluginBundlesV1 } from '../../dist/runtime/index.js'

import { PROCESS_TERMINAL_STATES } from './constants.mjs'
import { serviceError } from './errors.mjs'
import {
  createOperationRecord,
  getResource,
  requireExpectedGeneration,
  touchResource,
  useIdempotency
} from './registry-helpers.mjs'
import { cloneJson, requireInteger } from './validation.mjs'

export const admitRuntimePluginUpdate = async (
  context,
  processId,
  expectedGeneration,
  input,
  expectedRevision,
  idempotencyKey
) => {
  const runtimePlugins = normalizeRuntimePluginBundlesV1(input)
  const expected = requireInteger(expectedRevision, 'Plugin graph revision', { min: 0 })
  const now = context.now()
  return await context.store.transact(
    result => ({ data: { replayed: result.replayed }, subject: processId, type: 'runtime_plugins.admitted' }),
    draft => {
      const process = getResource(draft, 'processes', processId, 'Runtime process')
      requireExpectedGeneration(process, expectedGeneration)
      if (PROCESS_TERMINAL_STATES.has(process.state) || process.state !== 'running') {
        throw serviceError('service.conflict', 'Runtime process is not running')
      }
      const currentRevision = process.pluginGraphRevision ?? 0
      if (currentRevision !== expected) {
        throw serviceError('service.precondition_failed', 'Runtime plugin graph revision is stale', {
          details: { actualRevision: currentRevision, expectedRevision: expected }
        })
      }
      if (process.pendingPluginUpdate != null) {
        throw serviceError('service.conflict', 'Runtime plugin graph update is already pending')
      }
      return useIdempotency(
        draft,
        {
          key: idempotencyKey,
          scope: `runtime-plugins.replace:${processId}`,
          value: { expectedGeneration, expectedRevision: expected, runtimePlugins }
        },
        now,
        context.retentionMs,
        () => createAdmission(draft, process, runtimePlugins, currentRevision, now)
      )
    }
  )
}

function createAdmission(draft, process, runtimePlugins, currentRevision, now) {
  const operation = createOperationRecord(
    'runtime_plugins.replace',
    { generation: process.generation, id: process.id, type: 'process' },
    now
  )
  process.pendingPluginUpdate = {
    operationId: operation.id,
    pluginGraphRevision: currentRevision + 1,
    runtimePlugins
  }
  touchResource(process, now)
  draft.resources.operations[operation.id] = operation
  return { operation: cloneJson(operation), process: cloneJson(process) }
}

export const completeRuntimePluginUpdate = async (context, admitted, operationInput, succeeded) => {
  const now = context.now()
  return await context.store.transact(
    result => ({
      data: { applied: result.applied, pluginGraphRevision: result.process.pluginGraphRevision },
      subject: admitted.id,
      type: result.applied ? 'runtime_plugins.updated' : 'runtime_plugins.completion_ignored'
    }),
    draft => {
      const process = getResource(draft, 'processes', admitted.id, 'Runtime process')
      const operation = getResource(draft, 'operations', operationInput.id, 'Operation')
      const pending = process.pendingPluginUpdate
      const applied = operation.state === 'running' && process.generation === admitted.generation &&
        pending?.operationId === operation.id &&
        pending.pluginGraphRevision === admitted.pendingPluginUpdate.pluginGraphRevision
      if (applied) {
        if (succeeded) {
          process.pluginGraphRevision = pending.pluginGraphRevision
          process.runtimePlugins = pending.runtimePlugins
        }
        delete process.pendingPluginUpdate
        touchResource(process, now)
      }
      return { applied, process: cloneJson(process) }
    }
  )
}
