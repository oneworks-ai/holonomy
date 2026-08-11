import { redactAdapterFailure } from './adb-port.mjs'

export class RunnerCapabilityActions {
  #adapters
  #inspectorProxy
  #registry
  #schedule

  constructor(options) {
    this.#adapters = options.adapterDispatcher
    this.#inspectorProxy = options.inspectorProxy
    this.#registry = options.registry
    this.#schedule = options.schedule
  }

  inspector(value) {
    const { inspector, operation } = value
    const process = this.#registry.get('processes', inspector.processId, 'Runtime process')
    this.#schedule(process.deviceId, operation.id, async signal => {
      await this.#registry.updateOperation(operation.id, 'running')
      let result
      let current = inspector
      try {
        result = await this.#adapters.target(process.target).openInspector({ inspector, process, signal })
        const opened = await this.#registry.completeInspectorOpen(current, operation, 'ready', result)
        if (!opened.applied) {
          await this.#discardInspectorOpen(inspector, operation, process, result)
          return
        }
        current = opened.inspector
        if (result?.transport != null) {
          const endpoint = this.#inspectorProxy?.attach({
            diagnostics: result.diagnostics,
            inspector: current,
            process,
            transport: result.transport
          })
          if (endpoint != null) {
            const finalized = await this.#registry.completeInspectorOpen(current, operation, 'ready', endpoint)
            if (!finalized.applied) {
              await this.#discardInspectorOpen(inspector, operation, process, result)
              return
            }
            current = finalized.inspector
          }
        }
        await this.#registry.updateOperation(operation.id, 'succeeded', { result: { inspector: current } })
      } catch (error) {
        await this.#closeInspectorResult(inspector, process, result)
        const failed = await this.#registry.completeInspectorOpen(current, operation, 'failed')
        await this.#registry.updateOperation(operation.id, failed.applied ? 'failed' : 'cancelled', {
          ...(failed.applied ? { error: redactAdapterFailure(error) } : {})
        })
      }
    })
  }

  networkRules(value) {
    const { networkRules, operation } = value
    const process = this.#registry.get('processes', networkRules.processId, 'Runtime process')
    this.#schedule(process.deviceId, operation.id, async signal => {
      await this.#registry.updateOperation(operation.id, 'running')
      try {
        await this.#adapters.target(process.target).applyNetworkRules({ networkRules, process, signal })
        const completed = await this.#registry.completeNetworkRules(networkRules, operation, 'active')
        await this.#registry.updateOperation(operation.id, 'succeeded', {
          result: { networkRules: completed.networkRules }
        })
      } catch {
        await this.#registry.completeNetworkRules(networkRules, operation, 'failed')
        await this.#registry.updateOperation(operation.id, 'failed', { error: redactAdapterFailure() })
      }
    })
  }

  removeNetworkRules(value) {
    const { networkRules, operation } = value
    const process = this.#registry.get('processes', networkRules.processId, 'Runtime process')
    this.#schedule(process.deviceId, operation.id, async signal => {
      await this.#registry.updateOperation(operation.id, 'running')
      try {
        await this.#adapters.target(process.target).removeNetworkRules({ networkRules, process, signal })
        const completed = await this.#registry.completeNetworkRules(networkRules, operation, 'removed')
        await this.#registry.updateOperation(operation.id, 'succeeded', {
          result: { networkRules: completed.networkRules }
        })
      } catch {
        await this.#registry.completeNetworkRules(networkRules, operation, 'failed')
        await this.#registry.updateOperation(operation.id, 'failed', { error: redactAdapterFailure() })
      }
    })
  }

  async #discardInspectorOpen(inspector, operation, process, result) {
    await this.#closeInspectorResult(inspector, process, result)
    await this.#registry.updateOperation(operation.id, 'cancelled')
  }

  async #closeInspectorResult(inspector, process, result) {
    const closedProxy = this.#inspectorProxy?.closeLease(inspector.id) === true
    if (!closedProxy) result?.transport?.close?.()
    await this.#adapters.target(process.target).closeInspector({ inspector, process }).catch(() => undefined)
  }
}
