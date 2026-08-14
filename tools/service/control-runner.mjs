/* eslint-disable max-lines -- queued lifecycle transitions and their resource finalizers share one runner. */

import { redactAdapterFailure } from './adb-port.mjs'
import { PROCESS_TERMINAL_STATES } from './constants.mjs'
import { RunnerCapabilityActions } from './control-runner-capabilities.mjs'
import { DeviceOperationScheduler } from './device-operation-scheduler.mjs'
import { ConformanceFixtureManager } from './fixture-manager.mjs'
import { closeProcessLeases } from './process-lease-cleanup.mjs'
import { ProcessLifecycleWatcher } from './process-lifecycle-watcher.mjs'
import { startSandboxedAdapterProcess } from './sandbox-adapter-launch.mjs'
import { stageSandboxedAdapterProcess } from './sandbox-process-staging.mjs'

export class HolonomyControlRunner {
  #adapters
  #capabilities
  #capabilityRuntime
  #fixtures
  #inspectorProxy
  #lifecycle
  #outputs
  #registry
  #scheduler = new DeviceOperationScheduler()

  constructor(options) {
    this.#adapters = options.adapterDispatcher
    this.#fixtures = options.fixtureManager ?? new ConformanceFixtureManager()
    this.#inspectorProxy = options.inspectorProxy
    this.#outputs = options.outputPump
    this.#registry = options.registry
    this.#lifecycle = new ProcessLifecycleWatcher({
      adapterDispatcher: this.#adapters,
      closeLeases: process => this.#finishProcess(process),
      registry: this.#registry,
      schedule: (deviceId, key, work) => this.#scheduler.schedule(deviceId, key, work)
    })
    this.#outputs.setFailureHandler?.(process => this.#lifecycle.lost(process, 'output_unavailable'))
    this.#capabilities = new RunnerCapabilityActions({
      adapterDispatcher: this.#adapters,
      inspectorProxy: this.#inspectorProxy,
      registry: this.#registry,
      schedule: (deviceId, operationId, work) => this.#scheduler.schedule(deviceId, operationId, work)
    })
    this.#capabilityRuntime = options.capabilityRuntime
  }

  scheduleStart(value) {
    const { operation, process } = value
    this.#scheduler.schedule(process.deviceId, operation.id, async signal => {
      if (signal.aborted) {
        await this.#registry.updateOperation(operation.id, 'cancelled')
        return
      }
      await this.#registry.updateOperation(operation.id, 'running')
      await this.#registry.updateProcess(process.id, process.generation, { state: 'staging' })
      try {
        const current = await this.#startAdapterProcess(process, value.networkRules, signal, operation)
        await this.#registry.updateOperation(operation.id, 'succeeded', { result: { process: current } })
      } catch (error) {
        if (value.networkRules != null) {
          await this.#registry.completeNetworkRules(value.networkRules, operation, 'failed')
        }
        if (signal.aborted) await this.#registry.updateOperation(operation.id, 'cancelled')
        else await this.#failProcess(process.id, process.generation, operation.id, error)
      }
    })
  }

  cancelOperation(operationId) {
    return this.#scheduler.cancel(operationId)
  }

  scheduleStop(value) {
    const { operation, process } = value
    this.#scheduler.schedule(process.deviceId, operation.id, async signal => {
      await this.#registry.updateOperation(operation.id, 'running')
      this.#lifecycle.unwatch(process)
      try {
        await this.#outputs.stop(process, { drain: true }).catch(() => undefined)
        if (!PROCESS_TERMINAL_STATES.has(process.state)) {
          await this.#adapters.target(process.target).stopProcess({ process, signal })
        }
      } catch (error) {
        await this.#failProcess(process.id, process.generation, operation.id, error)
        return
      }
      await this.#closeProcessLeases(process)
      const current = await this.#registry.updateProcess(process.id, process.generation, {
        activeOperationId: null,
        exit: { reason: 'stopped' },
        state: PROCESS_TERMINAL_STATES.has(process.state) ? process.state : 'cancelled'
      })
      await this.#registry.updateOperation(operation.id, 'succeeded', { result: { process: current } })
    })
  }

  scheduleRestart(value, expectedGeneration) {
    const { operation, process } = value
    this.#scheduler.schedule(process.deviceId, operation.id, async signal => {
      await this.#registry.updateOperation(operation.id, 'running')
      this.#lifecycle.unwatch(process)
      try {
        const adapter = this.#adapters.target(process.target)
        await this.#outputs.stop(process, { drain: true }).catch(() => undefined)
        if (!PROCESS_TERMINAL_STATES.has(process.state)) await adapter.stopProcess({ process, signal })
        await this.#closeProcessLeases(process)
        const restarted = await this.#registry.beginRestart(process.id, expectedGeneration, operation.id)
        const current = await this.#startAdapterProcess(restarted, undefined, signal, operation)
        await this.#registry.updateOperation(operation.id, 'succeeded', { result: { process: current } })
      } catch (error) {
        const current = this.#registry.get('processes', process.id, 'Runtime process')
        await this.#failProcess(current.id, current.generation, operation.id, error)
      }
    })
  }

  scheduleResume(value) {
    const { operation, process } = value
    this.#scheduler.schedule(process.deviceId, operation.id, async signal => {
      await this.#registry.updateOperation(operation.id, 'running')
      try {
        await this.#adapters.target(process.target).resumeProcess({ process, signal })
        const current = await this.#registry.updateProcess(process.id, process.generation, {
          activeOperationId: null,
          state: 'running'
        })
        await this.#registry.updateOperation(operation.id, 'succeeded', { result: { process: current } })
      } catch (error) {
        await this.#failProcess(process.id, process.generation, operation.id, error)
      }
    })
  }

  scheduleInspector = value => this.#capabilities.inspector(value)
  scheduleNetworkRules(value) {
    this.#capabilities.networkRules(value)
  }
  scheduleRuntimePlugins(value) {
    this.#capabilities.runtimePlugins(value)
  }
  scheduleRemoveNetworkRules(value) {
    this.#capabilities.removeNetworkRules(value)
  }
  async close() {
    this.#lifecycle.close()
    await this.#scheduler.close()
    await this.#outputs.close()
    await this.#fixtures.close()
    await this.#inspectorProxy?.close()
    await this.#adapters.close()
  }

  async #startAdapterProcess(process, networkRules, signal, operation) {
    const adapter = this.#adapters.target(process.target)
    const staged = await stageSandboxedAdapterProcess({
      adapter,
      fixtures: this.#fixtures,
      process,
      registry: this.#registry,
      signal
    })
    const result = await startSandboxedAdapterProcess({
      adapter,
      capabilityRuntime: await this.#capabilityRuntime.prepare(staged.process),
      fixtureRuntimeUrl: staged.fixtureRuntimeUrl,
      networkRules,
      process: staged.process,
      signal
    })
    this.#inspectorProxy?.attachDiagnostics(staged.process, result?.diagnostics)
    if (networkRules != null) await this.#registry.completeNetworkRules(networkRules, operation, 'active')
    const state = result?.waitingForDebugger === true ? 'waiting_for_debugger' : 'running'
    const current = await this.#registry.updateProcess(process.id, process.generation, {
      activeOperationId: null,
      ...(result?.sessionId == null ? {} : { sessionId: result.sessionId }),
      state
    })
    await this.#outputs.start(current)
    await this.#lifecycle.watch(current)
    return current
  }
  async #closeProcessLeases(process, options = {}) {
    await closeProcessLeases({
      adapters: this.#adapters,
      fixtures: this.#fixtures,
      inspectorProxy: this.#inspectorProxy,
      releaseFixture: options.releaseFixture,
      process,
      registry: this.#registry
    })
  }
  async #finishProcess(process) {
    await this.#outputs.stop(process, { drain: true }).catch(() => undefined)
    await this.#closeProcessLeases(process)
  }

  async #failProcess(processId, generation, operationId, error) {
    this.#lifecycle.unwatch({ generation, id: processId })
    await this.#outputs.stop({ generation, id: processId }).catch(() => undefined)
    const process = this.#registry.get('processes', processId, 'Runtime process')
    await this.#outputs.captureStartupFailure(process).catch(() => undefined)
    this.#inspectorProxy?.closeProcess(processId, generation)
    await this.#registry.updateProcess(processId, generation, {
      activeOperationId: null,
      exit: { reason: 'host_failure' },
      state: 'failed'
    })
    await this.#registry.updateOperation(operationId, 'failed', { error: redactAdapterFailure(error) })
  }
  async removeProcess(process) {
    this.#lifecycle.unwatch(process)
    await this.#closeProcessLeases(process, { releaseFixture: true })
    await this.#adapters.target(process.target).removeProcess({ process })
    await this.#outputs.remove(process)
  }

  async releaseRetainedFixtures(processIds) {
    await Promise.all(processIds.map(id => this.#fixtures.release?.(id) ?? this.#fixtures.stop(id)))
  }
}
