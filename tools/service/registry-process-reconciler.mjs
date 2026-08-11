import { ProcessReconciler } from './process-reconciler.mjs'

export const createRegistryProcessReconciler = (adapterDispatcher, registry) =>
  new ProcessReconciler({
    adapterDispatcher,
    onCleaned: async process => {
      if (process.cleanupPending === true) {
        await registry.updateProcessCleanupPending(process.id, process.generation, false)
      }
    },
    onPending: async process => {
      if (process.cleanupPending !== true) {
        await registry.updateProcessCleanupPending(process.id, process.generation, true)
        process.cleanupPending = true
      }
    }
  })
