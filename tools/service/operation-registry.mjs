import { assertOperationTransition, getResource, touchResource } from './registry-helpers.mjs'
import { cloneJson } from './validation.mjs'

const processIdFor = (draft, operation) => {
  if (operation.target.type === 'process') return operation.target.id
  if (operation.target.type === 'inspector') return draft.resources.inspectors[operation.target.id]?.processId
  if (operation.target.type === 'networkRules') return draft.resources.networkRules[operation.target.id]?.processId
  return undefined
}

const operationEvent = (draft, result, id) => {
  const processId = processIdFor(draft, result)
  return {
    data: { ...(processId == null ? {} : { processId }), state: result.state },
    subject: id,
    type: 'operation.updated'
  }
}

export const updateOperation = async (context, id, state, patch = {}) => {
  const now = context.now()
  return await context.store.transact(
    (result, draft) => operationEvent(draft, result, id),
    draft => {
      const operation = getResource(draft, 'operations', id, 'Operation')
      assertOperationTransition(operation.state, state)
      operation.state = state
      if (patch.error != null) operation.error = cloneJson(patch.error)
      if (patch.result != null) operation.result = cloneJson(patch.result)
      if (['cancelled', 'failed', 'succeeded'].includes(state)) operation.endedAt = now
      touchResource(operation, now)
      return cloneJson(operation)
    }
  )
}
