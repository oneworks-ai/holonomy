import { queueProcessRemovalCleanup } from './process-removal-cleanup.mjs'
import { terminalTime } from './registry-helpers.mjs'

export const pruneRegistryRetention = async (context, options = {}) => {
  const now = context.now()
  const cutoff = now - context.retentionMs
  const cleaned = new Set()
  const removedProcesses = []
  const key = resource => `${resource.id}:${resource.generation}:${terminalTime(resource)}`
  if (options.beforeRemoveProcess != null) {
    for (const resource of Object.values(context.store.getSnapshot().resources.processes)) {
      const ended = terminalTime(resource)
      if (resource.cleanupPending === true || resource.activeOperationId != null || ended == null || ended >= cutoff) {
        continue
      }
      try {
        await options.beforeRemoveProcess(resource)
        cleaned.add(key(resource))
      } catch { /* Retain the registry evidence until its target cleanup succeeds. */ }
    }
  }
  const result = await context.store.transact(
    result => ({ data: result, type: 'retention.pruned' }),
    draft => {
      const removed = { devices: 0, idempotency: 0, inspectors: 0, networkRules: 0, operations: 0, processes: 0 }
      for (const [key, record] of Object.entries(draft.idempotency)) {
        if (record.expiresAt <= now) {
          delete draft.idempotency[key]
          removed.idempotency += 1
        }
      }
      for (const collection of ['inspectors', 'networkRules', 'operations', 'processes']) {
        for (const [id, resource] of Object.entries(draft.resources[collection])) {
          if (collection === 'processes' && resource.cleanupPending === true) continue
          if (collection === 'processes' && resource.activeOperationId != null) continue
          if (collection === 'processes' && options.beforeRemoveProcess != null && !cleaned.has(key(resource))) continue
          const terminalAt = terminalTime(resource)
          if (terminalAt != null && terminalAt < cutoff) {
            if (collection === 'processes') {
              queueProcessRemovalCleanup(draft, resource)
              removedProcesses.push(resource)
            }
            delete draft.resources[collection][id]
            removed[collection] += 1
          }
        }
      }
      for (const [id, device] of Object.entries(draft.resources.devices)) {
        if (device.state === 'disconnected' && device.observedAt < cutoff) {
          delete draft.resources.devices[id]
          removed.devices += 1
        }
      }
      return removed
    }
  )
  for (const process of removedProcesses) await options.afterRemoveProcess?.(process)
  return result
}
