import { admitRuntimePluginUpdate, completeRuntimePluginUpdate } from './capability-runtime-plugin-registry.mjs'
import { DEFAULT_EVENT_RETENTION_MS } from './constants.mjs'
import { refreshDevices } from './device-registry.mjs'
import { admitInspector, completeInspectorOpen, updateInspector } from './inspector-registry.mjs'
import { admitNetworkRules, admitNetworkRulesRemove, completeNetworkRules } from './network-rules-registry.mjs'
import { updateOperation } from './operation-registry.mjs'
import { updateProcessCleanupPending } from './process-cleanup-registry.mjs'
import { admitProcessAction, admitProcessStart, beginRestart, updateProcess } from './process-registry.mjs'
import { removeProcess } from './process-removal.mjs'
import { finalizeProcessSandbox } from './process-sandbox-registry.mjs'
import { getResource, listResources } from './registry-helpers.mjs'
import { pruneRegistryRetention } from './retention.mjs'
import { cloneJson } from './validation.mjs'

export class ControlRegistry {
  #context

  constructor(store, options = {}) {
    this.#context = {
      capabilityRuntime: options.capabilityRuntime,
      now: options.now ?? Date.now,
      retentionMs: options.retentionMs ?? DEFAULT_EVENT_RETENTION_MS,
      store
    }
  }

  snapshot() {
    return this.#context.store.getSnapshot()
  }

  list(collection) {
    return listResources(this.#context.store.getSnapshot(), collection)
  }

  get(collection, id, label) {
    return cloneJson(getResource(this.#context.store.getSnapshot(), collection, id, label))
  }

  async refreshDevices(inputs) {
    return await refreshDevices(this.#context, inputs)
  }

  async admitProcessStart(input, idempotencyKey) {
    return await admitProcessStart(this.#context, input, idempotencyKey)
  }

  async admitProcessAction(kind, id, expectedGeneration, idempotencyKey) {
    return await admitProcessAction(this.#context, kind, id, expectedGeneration, idempotencyKey)
  }

  async beginRestart(id, expectedGeneration, operationId) {
    return await beginRestart(this.#context, id, expectedGeneration, operationId)
  }

  async finalizeProcessSandbox(id, expectedGeneration, input) {
    return await finalizeProcessSandbox(this.#context, id, expectedGeneration, input)
  }

  async updateProcess(id, expectedGeneration, patch) {
    return await updateProcess(this.#context, id, expectedGeneration, patch)
  }

  async updateProcessCleanupPending(id, expectedGeneration, pending) {
    return await updateProcessCleanupPending(this.#context, id, expectedGeneration, pending)
  }

  async admitRuntimePluginUpdate(processId, expectedGeneration, input, expectedRevision, idempotencyKey) {
    return await admitRuntimePluginUpdate(
      this.#context,
      processId,
      expectedGeneration,
      input,
      expectedRevision,
      idempotencyKey
    )
  }

  async completeRuntimePluginUpdate(process, operation, succeeded) {
    return await completeRuntimePluginUpdate(this.#context, process, operation, succeeded)
  }

  async removeProcess(id, expectedGeneration) {
    return await removeProcess(this.#context, id, expectedGeneration)
  }

  async updateOperation(id, state, patch) {
    return await updateOperation(this.#context, id, state, patch)
  }

  async admitInspector(processId, expectedGeneration, input, idempotencyKey) {
    return await admitInspector(this.#context, processId, expectedGeneration, input, idempotencyKey)
  }

  async updateInspector(id, state, patch) {
    return await updateInspector(this.#context, id, state, patch)
  }

  async completeInspectorOpen(inspector, operation, state, patch) {
    return await completeInspectorOpen(this.#context, inspector, operation, state, patch)
  }

  async admitNetworkRules(processId, expectedGeneration, ruleSet, expectedRuleRevision, idempotencyKey) {
    return await admitNetworkRules(
      this.#context,
      processId,
      expectedGeneration,
      ruleSet,
      expectedRuleRevision,
      idempotencyKey
    )
  }

  async completeNetworkRules(networkRules, operation, state) {
    return await completeNetworkRules(this.#context, networkRules, operation, state)
  }

  async admitNetworkRulesRemove(id, expectedGeneration, expectedRuleRevision, idempotencyKey) {
    return await admitNetworkRulesRemove(
      this.#context,
      id,
      expectedGeneration,
      expectedRuleRevision,
      idempotencyKey
    )
  }

  async pruneRetention() {
    return await pruneRegistryRetention(this.#context)
  }
}
