import { terminalTime } from './registry-helpers.mjs'

export const pruneRegistryRetention = async context => {
  const now = context.now()
  const cutoff = now - context.retentionMs
  return await context.store.transact(
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
          const terminalAt = terminalTime(resource)
          if (terminalAt != null && terminalAt < cutoff) {
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
}
