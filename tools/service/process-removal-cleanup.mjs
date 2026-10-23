import { serviceError } from './errors.mjs'
import { requireIdentifier, requireInteger, requireRecord } from './validation.mjs'

export const readProcessRemovalCleanups = snapshot => {
  const value = requireRecord(snapshot.pendingProcessCleanup ?? {}, 'Pending process removal cleanup')
  if (Object.keys(value).length > 4096) throw serviceError('service.state_corrupt', 'Process cleanup queue is invalid')
  return Object.entries(value).map(([id, input]) => {
    const entry = requireRecord(input, 'Process cleanup ticket')
    if (
      entry.id !== id || entry.target !== 'native' || Object.keys(entry).sort().join(',') !== 'generation,id,target'
    ) {
      throw serviceError('service.state_corrupt', 'Process cleanup ticket is invalid')
    }
    return {
      id: requireIdentifier(id, 'Process cleanup id'),
      generation: requireInteger(entry.generation, 'Process cleanup generation', { min: 1 }),
      target: 'native'
    }
  })
}

/** Persisted in the existing state/journal transaction that removes the owner record. */
export const queueProcessRemovalCleanup = (draft, process) => {
  if (process.target !== 'native') return
  const pending = draft.pendingProcessCleanup ??= {}
  if (pending[process.id] == null && Object.keys(pending).length >= 4096) {
    throw serviceError('service.limit_exceeded', 'Native removal cleanup queue is full')
  }
  pending[process.id] = { generation: process.generation, id: process.id, target: 'native' }
}

export const completeProcessRemovalCleanup = async (context, id, generation) =>
  await context.store.transact(
    () => ({ data: { generation, id }, subject: id, type: 'process.cleanup.completed' }),
    draft => {
      const current = draft.pendingProcessCleanup?.[id]
      if (current != null && current.generation === generation) delete draft.pendingProcessCleanup[id]
      return true
    }
  )
