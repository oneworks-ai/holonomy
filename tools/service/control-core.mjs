/* eslint-disable max-lines -- public process admission and generation fencing share one control facade. */

import { DEFAULT_EVENT_RETENTION_MS } from './constants.mjs'
import { createControlDeviceWatcher } from './control-device-watcher.mjs'
import { ControlDirectMutations } from './control-direct-mutations.mjs'
import { ControlNetworkRules } from './control-network-rules.mjs'
import { HolonomyControlRunner } from './control-runner.mjs'
import { controlStatus } from './control-status.mjs'
import { serviceError } from './errors.mjs'
import { InspectorCdpProxy } from './inspector-proxy.mjs'
import { DurableMutationCoordinator } from './mutation-coordinator.mjs'
import { createNodeRuntimeAdapter } from './node-target-adapter.mjs'
import { createOptionalAndroidRuntimeAdapter } from './optional-android-target-adapter.mjs'
import { createProcessOutputPublisher } from './process-output-events.mjs'
import { ProcessOutputPump } from './process-output-pump.mjs'
import { reconcileServiceState } from './reconcile-service-state.mjs'
import { createRegistryProcessReconciler } from './registry-process-reconciler.mjs'
import { ControlRegistry } from './registry.mjs'
import { createTargetAdapterDispatcher } from './target-adapters.mjs'

const resultValue = admission => admission.value

export class HolonomyControlCore {
  #adapters
  #direct
  #deviceWatcher
  #registry
  #runner
  #inspectorProxy
  #networkRules
  #outputs
  #reconciler
  #store

  constructor(options) {
    this.#adapters = options.adapterDispatcher ?? createTargetAdapterDispatcher({
      android: options.adbPort ?? createOptionalAndroidRuntimeAdapter(),
      node: options.nodeAdapter ?? createNodeRuntimeAdapter()
    })
    this.#store = options.store
    this.#inspectorProxy = options.inspectorProxy ?? new InspectorCdpProxy({ now: options.now })
    this.#registry = new ControlRegistry(options.store, {
      now: options.now,
      retentionMs: options.retentionMs ?? DEFAULT_EVENT_RETENTION_MS
    })
    this.#outputs = options.outputPump ?? new ProcessOutputPump({
      adapterDispatcher: this.#adapters,
      inspectorProxy: this.#inspectorProxy,
      logStore: options.logStore,
      pollIntervalMs: options.outputPollIntervalMs,
      publishOutput: createProcessOutputPublisher(this.#store)
    })
    this.#reconciler = createRegistryProcessReconciler(this.#adapters, this.#registry)
    this.#deviceWatcher = options.deviceWatcher ?? createControlDeviceWatcher({
      adapters: this.#adapters,
      intervalMs: options.deviceRefreshIntervalMs,
      now: options.now,
      reconciler: this.#reconciler,
      registry: this.#registry
    })
    this.#runner = new HolonomyControlRunner({
      adapterDispatcher: this.#adapters,
      fixtureManager: options.fixtureManager,
      inspectorProxy: this.#inspectorProxy,
      outputPump: this.#outputs,
      registry: this.#registry
    })
    this.#networkRules = new ControlNetworkRules({ registry: this.#registry, runner: this.#runner })
    this.#direct = new ControlDirectMutations({
      adapters: this.#adapters,
      mutations: options.mutationCoordinator ?? new DurableMutationCoordinator({ now: options.now }),
      registry: this.#registry,
      runner: this.#runner
    })
    this.#inspectorProxy.configureResume?.(async input => {
      const process = this.#registry.get('processes', input.processId, 'Runtime process')
      if (process.generation !== input.generation || process.state !== 'waiting_for_debugger') {
        throw serviceError('service.precondition_failed', 'Runtime process is not waiting for this inspector')
      }
      await this.resumeProcess(process.id, process.generation, input.idempotencyKey)
    })
  }

  async open() {
    await this.#store.open()
    await this.#outputs.open()
    await this.#reconciler.open(this.#store.getSnapshot())
    await reconcileServiceState(this.#store)
    await this.#registry.pruneRetention()
    await this.#store.pruneEvents()
    await this.#deviceWatcher.start()
  }
  snapshot() {
    return this.#registry.snapshot()
  }
  list(collection) {
    return this.#registry.list(collection)
  }
  get(collection, id, label) {
    return this.#registry.get(collection, id, label)
  }
  async refreshDevices() {
    return await this.#deviceWatcher.refresh()
  }
  async listEmulators() {
    return await this.#adapters.target('android').listEmulators({})
  }
  async startEmulator(id, input, idempotencyKey) {
    return await this.#direct.emulator('start', id, input, idempotencyKey)
  }
  async stopEmulator(id, idempotencyKey) {
    return await this.#direct.emulator('stop', id, {}, idempotencyKey)
  }
  async restartEmulator(id, input, idempotencyKey) {
    return await this.#direct.emulator('restart', id, input, idempotencyKey)
  }
  async startProcess(input, idempotencyKey) {
    const admission = await this.#registry.admitProcessStart(input, idempotencyKey)
    if (!admission.replayed) this.#runner.scheduleStart(resultValue(admission))
    return admission
  }
  async stopProcess(id, expectedGeneration, idempotencyKey) {
    const current = this.#registry.get('processes', id, 'Runtime process')
    const admission = await this.#registry.admitProcessAction('stop', id, expectedGeneration, idempotencyKey)
    if (!admission.replayed) {
      if (['queued', 'staging', 'starting'].includes(current.state) && current.activeOperationId != null) {
        this.#runner.cancelOperation(current.activeOperationId)
      }
      this.#runner.scheduleStop(resultValue(admission))
    }
    return admission
  }
  async restartProcess(id, expectedGeneration, idempotencyKey) {
    const admission = await this.#registry.admitProcessAction('restart', id, expectedGeneration, idempotencyKey)
    if (!admission.replayed) this.#runner.scheduleRestart(resultValue(admission), expectedGeneration)
    return admission
  }
  async resumeProcess(id, expectedGeneration, idempotencyKey) {
    const admission = await this.#registry.admitProcessAction('resume', id, expectedGeneration, idempotencyKey)
    if (!admission.replayed) this.#runner.scheduleResume(resultValue(admission))
    return admission
  }
  async removeProcess(id, expectedGeneration, idempotencyKey) {
    return await this.#direct.removeProcess(id, expectedGeneration, idempotencyKey)
  }
  async openInspector(processId, expectedGeneration, input, idempotencyKey) {
    const admission = await this.#registry.admitInspector(processId, expectedGeneration, input, idempotencyKey)
    if (!admission.replayed) this.#runner.scheduleInspector(resultValue(admission))
    return admission
  }
  async closeProcessInspector(processId, id, expectedGeneration, idempotencyKey) {
    const inspector = this.#registry.get('inspectors', id, 'Inspector lease')
    if (inspector.processId !== processId) throw serviceError('service.not_found', 'Inspector lease was not found')
    return await this.closeInspector(id, expectedGeneration, idempotencyKey)
  }
  async closeInspector(id, expectedGeneration, idempotencyKey) {
    const inspector = await this.#direct.closeInspector(id, expectedGeneration, idempotencyKey)
    this.#inspectorProxy.closeLease(id)
    return inspector
  }
  async replaceNetworkRules(processId, expectedGeneration, ruleSet, expectedRuleRevision, idempotencyKey) {
    return await this.#networkRules.replace(
      processId,
      expectedGeneration,
      ruleSet,
      expectedRuleRevision,
      idempotencyKey
    )
  }

  async removeNetworkRules(id, expectedGeneration, expectedRuleRevision, idempotencyKey) {
    return await this.#networkRules.remove(id, expectedGeneration, expectedRuleRevision, idempotencyKey)
  }
  async removeProcessNetworkRules(processId, expectedGeneration, expectedRuleRevision, idempotencyKey) {
    return await this.#networkRules.removeProcess(
      processId,
      expectedGeneration,
      expectedRuleRevision,
      idempotencyKey
    )
  }
  async readLogs(processId, options = {}) {
    this.#registry.get('processes', processId, 'Runtime process')
    return await this.#outputs.page(processId, options)
  }
  async pruneRetention() {
    const retainedProcessIds = new Set(this.#registry.list('processes').map(process => process.id))
    const resources = await this.#registry.pruneRetention()
    const currentProcessIds = new Set(this.#registry.list('processes').map(process => process.id))
    const expiredProcessIds = [...retainedProcessIds].filter(id => !currentProcessIds.has(id))
    await this.#runner.releaseRetainedFixtures(expiredProcessIds)
    const events = await this.#store.pruneEvents()
    const logs = await this.#outputs.prune()
    return { events, logs, resources }
  }
  async readEvents(after, options) {
    return await this.#store.readEvents(after, options)
  }
  subscribeEvents(listener) {
    return this.#store.subscribe(listener)
  }

  inspectorProxy() {
    return this.#inspectorProxy
  }

  serviceStatus() {
    return controlStatus(this.snapshot())
  }

  async close() {
    await this.#deviceWatcher.close()
    await this.#runner.close()
  }
}
