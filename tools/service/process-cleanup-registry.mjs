import { getResource, requireExpectedGeneration, touchResource } from './registry-helpers.mjs'
import { cloneJson } from './validation.mjs'

export const updateProcessCleanupPending = async (context, id, expectedGeneration, pending) => {
  const now = context.now()
  return await context.store.transact(
    result => ({
      data: { cleanupPending: result.cleanupPending === true, generation: result.generation },
      subject: id,
      type: 'process.cleanup.updated'
    }),
    draft => {
      const process = getResource(draft, 'processes', id, 'Runtime process')
      requireExpectedGeneration(process, expectedGeneration)
      if (pending === true) process.cleanupPending = true
      else delete process.cleanupPending
      touchResource(process, now)
      return cloneJson(process)
    }
  )
}
