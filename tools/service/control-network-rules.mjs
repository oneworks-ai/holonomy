import { serviceError } from './errors.mjs'

export class ControlNetworkRules {
  #registry
  #runner

  constructor(options) {
    this.#registry = options.registry
    this.#runner = options.runner
  }

  async replace(processId, expectedGeneration, ruleSet, expectedRuleRevision, idempotencyKey) {
    const admission = await this.#registry.admitNetworkRules(
      processId,
      expectedGeneration,
      ruleSet,
      expectedRuleRevision,
      idempotencyKey
    )
    if (!admission.replayed) this.#runner.scheduleNetworkRules(admission.value)
    return admission
  }

  async remove(id, expectedGeneration, expectedRuleRevision, idempotencyKey) {
    const admission = await this.#registry.admitNetworkRulesRemove(
      id,
      expectedGeneration,
      expectedRuleRevision,
      idempotencyKey
    )
    if (!admission.replayed) this.#runner.scheduleRemoveNetworkRules(admission.value)
    return admission
  }

  async removeProcess(processId, expectedGeneration, expectedRuleRevision, idempotencyKey) {
    const current = this.#registry.list('networkRules')
      .filter(value =>
        value.processId === processId && value.generation === expectedGeneration && value.state !== 'removed'
      )
      .sort((left, right) => right.revision - left.revision)[0]
    if (current == null) throw serviceError('service.not_found', 'Network rules were not found')
    return await this.remove(current.id, expectedGeneration, expectedRuleRevision, idempotencyKey)
  }
}
