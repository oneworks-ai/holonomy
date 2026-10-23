import { PROCESS_TERMINAL_STATES } from './constants.mjs'
import { serviceError } from './errors.mjs'
import { assertProcessTransition, getResource, requireExpectedGeneration, touchResource } from './registry-helpers.mjs'
import { cloneJson } from './validation.mjs'

export const completeProcessStop = async (context, admitted, operationId, outcome = 'stopped') => {
  if (outcome !== 'stopped' && outcome !== 'failed') {
    throw serviceError('service.invalid_request', 'Runtime process stop outcome is invalid')
  }
  const now = context.now()
  return await context.store.transact(
    result => ({
      data: { generation: result.generation, state: result.state },
      subject: admitted.id,
      type: 'process.updated'
    }),
    draft => {
      const process = getResource(draft, 'processes', admitted.id, 'Runtime process')
      requireExpectedGeneration(process, admitted.generation)
      const operation = getResource(draft, 'operations', operationId, 'Operation')
      if (
        operation.kind !== 'process.stop' || operation.target.type !== 'process' ||
        operation.target.id !== admitted.id || operation.target.generation !== admitted.generation
      ) {
        throw serviceError('service.precondition_failed', 'Runtime process operation is stale')
      }
      if (process.activeOperationId != null && process.activeOperationId !== operationId) {
        throw serviceError('service.precondition_failed', 'Runtime process operation is stale')
      }
      if (PROCESS_TERMINAL_STATES.has(process.state)) {
        if (process.activeOperationId === operationId) {
          delete process.activeOperationId
          touchResource(process, now)
        }
        return cloneJson(process)
      }
      if (process.activeOperationId !== operationId) {
        throw serviceError('service.precondition_failed', 'Runtime process operation is stale')
      }
      const state = outcome === 'failed' ? 'failed' : 'cancelled'
      assertProcessTransition(process.state, state)
      process.state = state
      process.endedAt = now
      process.exit = { reason: outcome === 'failed' ? 'host_failure' : 'stopped' }
      delete process.activeOperationId
      touchResource(process, now)
      return cloneJson(process)
    }
  )
}
