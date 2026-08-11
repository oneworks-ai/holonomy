import { PROCESS_TERMINAL_STATES } from './constants.mjs'
import { serviceError } from './errors.mjs'
import { cloneJson } from './validation.mjs'

export class ControlDirectMutations {
  #adapters
  #mutations
  #registry
  #runner

  constructor(options) {
    this.#adapters = options.adapters
    this.#mutations = options.mutations
    this.#registry = options.registry
    this.#runner = options.runner
  }

  async emulator(action, id, input, idempotencyKey) {
    return await this.#mutations.execute(`emulator.${action}:${id}`, idempotencyKey, input, async () => {
      const adapter = this.#adapters.target('android')
      if (action === 'start') return await adapter.startEmulator({ id, options: cloneJson(input) })
      if (action === 'restart') return await adapter.restartEmulator({ id, options: cloneJson(input) })
      return await adapter.stopEmulator({ id })
    })
  }

  async closeInspector(id, expectedGeneration, idempotencyKey) {
    return await this.#mutations.execute(
      `inspector.close:${id}`,
      idempotencyKey,
      { expectedGeneration },
      async () => {
        const inspector = this.#registry.get('inspectors', id, 'Inspector lease')
        if (['closed', 'failed', 'lost'].includes(inspector.state)) return inspector
        const process = this.#registry.get('processes', inspector.processId, 'Runtime process')
        if (inspector.generation !== expectedGeneration || process.generation !== expectedGeneration) {
          throw serviceError('service.precondition_failed', 'Inspector generation is stale', {
            details: { actualGeneration: process.generation, expectedGeneration }
          })
        }
        await this.#adapters.target(process.target).closeInspector({ inspector, process })
        return await this.#registry.updateInspector(id, 'closed')
      }
    )
  }

  async removeProcess(id, expectedGeneration, idempotencyKey) {
    return await this.#mutations.execute(
      `process.remove:${id}`,
      idempotencyKey,
      { expectedGeneration },
      async () => {
        const process = this.#registry.get('processes', id, 'Runtime process')
        if (process.generation !== expectedGeneration) {
          throw serviceError('service.precondition_failed', 'Runtime process generation is stale', {
            details: { actualGeneration: process.generation, expectedGeneration }
          })
        }
        if (!PROCESS_TERMINAL_STATES.has(process.state)) {
          throw serviceError('service.conflict', 'Active Runtime process must be stopped before removal')
        }
        await this.#runner.removeProcess(process)
        return await this.#registry.removeProcess(id, expectedGeneration)
      }
    )
  }
}
