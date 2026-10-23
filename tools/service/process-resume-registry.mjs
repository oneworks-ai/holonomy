import { assertProcessTransition, getResource, touchResource } from './registry-helpers.mjs'
import { cloneJson } from './validation.mjs'

// Complete only the still-current resume. Stop/restart admission may supersede
// it while the adapter is awaiting an acknowledgement; never revive that state.
export const completeProcessResume = async (context, admitted, operation, succeeded, cleanupPending) => {
  const now = context.now()
  return await context.store.transact(result => ({
    data: { generation: admitted.generation, state: result.process.state },
    subject: admitted.id,
    type: result.applied ? 'process.updated' : 'process.resume.completion_ignored'
  }), draft => {
    const process = getResource(draft, 'processes', admitted.id, 'Runtime process')
    const action = getResource(draft, 'operations', operation.id, 'Operation')
    const retainCleanup = cleanupPending && process.generation === admitted.generation && !process.cleanupPending
    if (retainCleanup) process.cleanupPending = true
    if (
      process.generation !== admitted.generation || process.activeOperationId !== operation.id ||
      process.state !== 'waiting_for_debugger' || action.state !== 'running'
    ) {
      if (retainCleanup) touchResource(process, now)
      return { applied: false, process: cloneJson(process) }
    }
    assertProcessTransition(process.state, succeeded ? 'running' : 'failed')
    process.state = succeeded ? 'running' : 'failed'
    delete process.activeOperationId
    if (!succeeded) {
      process.exit = { reason: 'host_failure' }
      process.endedAt = now
    }
    touchResource(process, now)
    return { applied: true, process: cloneJson(process) }
  })
}
