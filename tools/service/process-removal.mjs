import { PROCESS_TERMINAL_STATES } from './constants.mjs'
import { serviceError } from './errors.mjs'
import { getResource, requireExpectedGeneration } from './registry-helpers.mjs'
import { cloneJson } from './validation.mjs'

export const removeProcess = async (context, id, expectedGeneration) => {
  const now = context.now()
  return await context.store.transact(
    result => ({ data: result.removed, subject: id, type: 'process.removed' }),
    draft => {
      const process = getResource(draft, 'processes', id, 'Runtime process')
      requireExpectedGeneration(process, expectedGeneration)
      if (!PROCESS_TERMINAL_STATES.has(process.state)) {
        throw serviceError('service.conflict', 'Active Runtime process must be stopped before removal')
      }
      if (process.cleanupPending === true) {
        throw serviceError('service.conflict', 'Runtime process cleanup is still pending')
      }
      const removed = { idempotency: 0, inspectors: 0, networkRules: 0, operations: 0, process: 1 }
      const inspectorIds = new Set()
      for (const [inspectorId, inspector] of Object.entries(draft.resources.inspectors)) {
        if (inspector.processId !== id) continue
        inspectorIds.add(inspectorId)
        delete draft.resources.inspectors[inspectorId]
        removed.inspectors += 1
      }
      for (const [rulesId, rules] of Object.entries(draft.resources.networkRules)) {
        if (rules.processId !== id) continue
        delete draft.resources.networkRules[rulesId]
        removed.networkRules += 1
      }
      for (const [operationId, operation] of Object.entries(draft.resources.operations)) {
        if (operation.target?.id !== id && !inspectorIds.has(operation.target?.id)) continue
        delete draft.resources.operations[operationId]
        removed.operations += 1
      }
      for (const [recordId, record] of Object.entries(draft.idempotency)) {
        const response = record.response
        if (
          response?.process?.id !== id && response?.networkRules?.processId !== id &&
          response?.inspector?.processId !== id
        ) continue
        delete draft.idempotency[recordId]
        removed.idempotency += 1
      }
      delete draft.resources.processes[id]
      return { process: cloneJson(process), removed, removedAt: now }
    }
  )
}
