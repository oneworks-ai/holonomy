import { newResourceId } from './registry-helpers.mjs'
import { cloneJson } from './validation.mjs'

export const createInitialNetworkRules = (draft, process, ruleSet, now) => {
  const networkRules = {
    createdAt: now,
    generation: process.generation,
    id: newResourceId('network_rules'),
    mode: ruleSet.mode,
    processId: process.id,
    revision: 1,
    ruleRevision: '1',
    rules: cloneJson(ruleSet.rules),
    state: 'applying',
    updatedAt: now
  }
  draft.resources.networkRules[networkRules.id] = networkRules
  return networkRules
}
