import {
  INSPECTOR_TERMINAL_STATES,
  NETWORK_RULE_TERMINAL_STATES,
  OPERATION_TERMINAL_STATES,
  PROCESS_TERMINAL_STATES
} from './constants.mjs'

const touch = (resource, now) => {
  resource.revision += 1
  resource.updatedAt = now
}

export const reconcileServiceState = async (store, now = Date.now) => {
  const resources = store.getSnapshot().resources
  const stale = Object.values(resources.processes).some(value => !PROCESS_TERMINAL_STATES.has(value.state)) ||
    Object.values(resources.operations).some(value => !OPERATION_TERMINAL_STATES.has(value.state)) ||
    Object.values(resources.inspectors).some(value => !INSPECTOR_TERMINAL_STATES.has(value.state)) ||
    Object.values(resources.networkRules).some(value => !NETWORK_RULE_TERMINAL_STATES.has(value.state))
  if (!stale) return { inspectors: 0, networkRules: 0, operations: 0, processes: 0 }
  return await store.transact(
    result => ({ data: result, type: 'service.reconciled' }),
    draft => {
      const result = { inspectors: 0, networkRules: 0, operations: 0, processes: 0 }
      const at = now()
      for (const process of Object.values(draft.resources.processes)) {
        if (PROCESS_TERMINAL_STATES.has(process.state)) continue
        process.state = 'lost'
        process.endedAt = at
        process.exit = { reason: 'service_restart' }
        delete process.activeOperationId
        touch(process, at)
        result.processes += 1
      }
      for (const operation of Object.values(draft.resources.operations)) {
        if (OPERATION_TERMINAL_STATES.has(operation.state)) continue
        operation.state = 'failed'
        operation.endedAt = at
        operation.error = { code: 'service.unavailable', retryable: true }
        touch(operation, at)
        result.operations += 1
      }
      for (const inspector of Object.values(draft.resources.inspectors)) {
        if (INSPECTOR_TERMINAL_STATES.has(inspector.state)) continue
        inspector.state = 'lost'
        inspector.closedAt = at
        touch(inspector, at)
        result.inspectors += 1
      }
      for (const rules of Object.values(draft.resources.networkRules)) {
        if (NETWORK_RULE_TERMINAL_STATES.has(rules.state)) continue
        rules.state = 'failed'
        rules.endedAt = at
        touch(rules, at)
        result.networkRules += 1
      }
      return result
    }
  )
}
