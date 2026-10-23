/* eslint-disable max-lines -- queued lifecycle transitions and their resource finalizers share one runner. */

import { redactAdapterFailure } from './adb-port.mjs'
import { OPERATION_TERMINAL_STATES, PROCESS_TERMINAL_STATES } from './constants.mjs'
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
      let stopConfirmed = PROCESS_TERMINAL_STATES.has(process.state)
      let stopAttempted = false
      try {
        await this.#registry.updateOperation(operation.id, 'running')
        this.#lifecycle.unwatch(process)
        await this.#outputs.stop(process, { drain: true }).catch(() => undefined)
        if (!stopConfirmed) {
          stopAttempted = true
          await this.#adapters.target(process.target).stopProcess({ process, signal })
          stopConfirmed = true
        }
        await this.#closeProcessLeases(process)
        const current = await this.#registry.completeProcessStop(process, operation.id)
        await this.#registry.updateOperation(operation.id, 'succeeded', { result: { process: current } })
      } catch (error) {
        await this.#failStop(process, operation.id, error, { signal, stopAttempted, stopConfirmed })
      }
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
    return this.#scheduler.schedule(process.deviceId, operation.id, async signal => {
      await this.#registry.updateOperation(operation.id, 'running')
      let failure
      let failed = false
      let cleanupPending = false
      try {
        await this.#adapters.target(process.target).resumeProcess({ process, signal })
      } catch (error) {
        failed = true
        failure = error
        if (process.target === 'native') {
          // An acknowledgement can be lost after Rust released entry. Reap the
          // owned generation before publishing failure; never infer rollback.
          try {
            await this.#adapters.target(process.target).stopProcess({ process, signal })
          } catch {
            cleanupPending = true
          }
        }
      }
      const completed = await this.#registry.completeProcessResume(process, operation, !failed, cleanupPending)
      if (!completed.applied) {
        if (['queued', 'running'].includes(this.#registry.get('operations', operation.id, 'Operation').state)) {
          await this.#registry.updateOperation(operation.id, 'cancelled')
        }
        return
      }
      if (failed) {
        this.#lifecycle.unwatch(process)
        await this.#outputs.stop(process).catch(() => undefined)
        await this.#outputs.captureStartupFailure(completed.process).catch(() => undefined)
        this.#inspectorProxy?.closeProcess(process.id, process.generation)
      }
      await this.#registry.updateOperation(
        operation.id,
        failed ? 'failed' : 'succeeded',
        !failed
          ? { result: { process: completed.process } }
          : { error: redactAdapterFailure(failure) }
      )
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
    try {
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
    } catch (error) {
      try {
        await adapter.stopProcess({ process: staged.process })
      } catch {
        await this.#registry.updateProcessCleanupPending(process.id, process.generation, true).catch(() => undefined)
      }
      throw error
    }
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

  async #failStop(process, operationId, error, status) {
    let recoveryError
    try {
      try {
        this.#lifecycle.unwatch(process)
      } catch { /* Keep closing the owned generation. */ }
      await this.#outputs.stop(process).catch(() => undefined)
      let live = this.#registry.get('processes', process.id, 'Runtime process')
      let cleanupPending = error?.details?.cleanupPending === true
      if (
        !status.stopAttempted && !status.stopConfirmed && live.generation === process.generation &&
        !PROCESS_TERMINAL_STATES.has(live.state)
      ) {
        try {
          await this.#adapters.target(process.target).stopProcess({ process, signal: status.signal })
          status.stopConfirmed = true
        } catch {
          cleanupPending = true
        }
      }
      if (!status.stopConfirmed && live.generation === process.generation && !PROCESS_TERMINAL_STATES.has(live.state)) {
        cleanupPending = true
      }
      if (cleanupPending) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await this.#registry.updateProcessCleanupPending(process.id, process.generation, true)
            break
          } catch (failure) {
            if (attempt === 1) throw failure
          }
        }
      }
      live = this.#registry.get('processes', process.id, 'Runtime process')
      if (live.generation === process.generation) {
        await this.#outputs.captureStartupFailure(live).catch(() => undefined)
        try {
          this.#inspectorProxy?.closeProcess(process.id, process.generation)
        } catch { /* Preserve the stop failure. */ }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await this.#registry.completeProcessStop(process, operationId, 'failed')
            break
          } catch (failure) {
            const current = this.#registry.get('processes', process.id, 'Runtime process')
            if (current.generation !== process.generation) break
            if (PROCESS_TERMINAL_STATES.has(current.state) && current.activeOperationId !== operationId) break
            if (attempt === 1) throw failure
          }
        }
      }
    } catch (failure) {
      recoveryError = failure
    }
    // A cleanup side effect must not keep the public operation running.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const selected = this.#registry.get('operations', operationId, 'Operation')
        if (OPERATION_TERMINAL_STATES.has(selected.state)) break
        await this.#registry.updateOperation(operationId, 'failed', { error: redactAdapterFailure(error) })
        break
      } catch (failure) {
        if (attempt === 1) throw failure
      }
    }
    if (recoveryError != null) throw recoveryError
  }

  async #failProcess(processId, generation, operationId, error) {
    if (error?.details?.cleanupPending === true) {
      await this.#registry.updateProcessCleanupPending(processId, generation, true).catch(() => undefined)
    }
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
  async releaseExpiredProcess(process) {
    if (process.target === 'native') await this.#adapters.target('native').removeProcess({ process })
    await this.releaseRetainedFixtures([process.id])
    await this.#outputs.remove(process)
  }
  async finalizeRemovedProcess(process) {
    if (process.target === 'native') {
      await this.#adapters.target('native').removeProcess({ process, finalized: true })
      await this.#registry.completeRemovalCleanup(process.id, process.generation)
    }
  }
  async retryRemovalCleanups() {
    const retained = new Set(this.#registry.list('processes').map(process => process.id))
    for (const process of this.#registry.pendingRemovalCleanups()) {
      if (retained.has(process.id)) continue
      try {
        await this.finalizeRemovedProcess(process)
      } catch { /* Durable ticket survives for the next maintenance pass. */ }
    }
  }
}
