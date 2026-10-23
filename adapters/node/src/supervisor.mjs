/* eslint-disable max-lines -- supervisor lifecycle and its exact IPC request fencing stay co-located. */

import { Buffer } from 'node:buffer'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import process from 'node:process'

// Built Runtime contracts are the Node adapter's production ABI.
// eslint-disable-next-line antfu/no-import-dist
import {
  NODE_RUNTIME_OBSERVER_PLATFORM_V1,
  RuntimeObserverRegistryV1,
  compileSandboxPolicyV2,
  normalizeEngineGateDecisionV1,
  normalizeEngineGateRequestMetadataV1
} from '../../../dist/capability-runtime/index.js'

import { verifyInstalledV86ProcessProfileV1 } from './capability-process-v86-installation.mjs'
import { normalizeNodeRuntimePluginUpdateV1 } from './capability-runtime-plugins.mjs'
import { createParentCommand, readChildEvent } from './protocol.mjs'
import { prepareHolonomyNodeSession } from './runtime-assets.mjs'
import { normalizeNetworkRules, normalizeNodeRuntimeSession } from './session-validation.mjs'
import { wireNodeRuntimeSessionV1 } from './supervisor-session.mjs'

const CHILD_URL = new URL('./child-runtime.mjs', import.meta.url)
const DEFAULT_OBSERVER_HOST_CAPS = Object.freeze({
  maxObserverCallbackMs: 120_000,
  maxQueuedEvents: 4096
})
const DEFAULT_SOURCE_READER_HOST_CAPS = Object.freeze({ maxReadBytes: 0 })

const adapterError = code => Object.assign(new Error(`Node adapter ${code}`), { code })

const normalizeObserverBindings = value => {
  if (!Array.isArray(value)) throw new TypeError('Invalid Node Runtime Observer bindings')
  const bindings = new Map()
  for (const item of value) {
    if (
      item == null || typeof item !== 'object' || Array.isArray(item) ||
      typeof item.bindingId !== 'string' || typeof item.ownerId !== 'string' ||
      typeof item.version !== 'string' || typeof item.observer !== 'function' ||
      item.registration == null || typeof item.registration !== 'object'
    ) throw new TypeError('Invalid Node Runtime Observer binding')
    if (bindings.has(item.bindingId)) throw new TypeError('Duplicate Node Runtime Observer binding')
    bindings.set(item.bindingId, Object.freeze({ ...item }))
  }
  return bindings
}

export class NodeRuntimeSupervisor extends EventEmitter {
  #requestedTermination = new WeakSet()
  #child
  #engineGate
  #engineGateConfiguration
  #engineGatePending = new Map()
  #generation = 0
  #observerBindings
  #observerHostCaps
  #observerRegistry
  #pending = new Map()
  #requestId = 0
  #rulesRevision = 0
  #session
  #sourceReaderHostCaps
  #state = 'idle'
  #stopPromise
  #timeoutMs

  constructor(
    {
      engineGate,
      observerBindings = [],
      observerHostCaps = DEFAULT_OBSERVER_HOST_CAPS,
      requestTimeoutMs = 10_000,
      sourceReaderHostCaps = DEFAULT_SOURCE_READER_HOST_CAPS
    } = {}
  ) {
    super()
    if (engineGate != null && typeof engineGate !== 'function') throw new TypeError('Invalid Node Engine Gate')
    if (observerHostCaps == null || typeof observerHostCaps !== 'object' || Array.isArray(observerHostCaps)) {
      throw new TypeError('Invalid Node Runtime Observer Host caps')
    }
    if (
      sourceReaderHostCaps == null || typeof sourceReaderHostCaps !== 'object' ||
      Array.isArray(sourceReaderHostCaps) ||
      !Number.isSafeInteger(sourceReaderHostCaps.maxReadBytes) ||
      sourceReaderHostCaps.maxReadBytes < 0 || sourceReaderHostCaps.maxReadBytes > 1024 * 1024 ||
      sourceReaderHostCaps.maxReadBytes > 0 &&
        sourceReaderHostCaps.capabilityName !== 'host.diagnostics.source.read'
    ) throw new TypeError('Invalid Node Engine source reader Host caps')
    this.#engineGate = engineGate
    this.#observerBindings = normalizeObserverBindings(observerBindings)
    this.#observerHostCaps = Object.freeze({ ...observerHostCaps })
    this.#sourceReaderHostCaps = Object.freeze({ ...sourceReaderHostCaps })
    this.#timeoutMs = requestTimeoutMs
  }

  get generation() {
    return this.#generation
  }

  get state() {
    return this.#state
  }

  async start(input) {
    if (this.#child != null || !['idle', 'stopped'].includes(this.#state)) throw adapterError('invalid_state')
    const replayableSession = normalizeNodeRuntimeSession(input)
    const session = normalizeNodeRuntimeSession(
      await prepareHolonomyNodeSession(wireNodeRuntimeSessionV1(replayableSession))
    )
    const installation = session.capabilityRuntime?.providerConfiguration.processBackendInstallation
    if (installation != null) {
      await verifyInstalledV86ProcessProfileV1(
        session.capabilityRuntime.providerConfiguration.processProfile,
        installation
      )
    }
    const nextGeneration = this.#generation + 1
    const observerRegistry = this.#createObserverRegistry(session, nextGeneration)
    this.#session = Object.freeze(wireNodeRuntimeSessionV1(replayableSession))
    this.#generation = nextGeneration
    this.#observerRegistry = observerRegistry
    this.#rulesRevision = 0
    this.#setState('starting')
    let child
    try {
      child = fork(CHILD_URL, [], {
        env: {
          HOLO_ENGINE_GATE_REQUEST_FD: '4',
          HOLO_ENGINE_GATE_RESPONSE_FD: '5',
          NODE_NO_WARNINGS: '1',
          ...(process.env.HOLO_V86_TRACE === '1' ? { HOLO_V86_TRACE: '1' } : {})
        },
        execArgv: [
          session.inspector.enabled ? '--inspect=127.0.0.1:0' : '',
          '--experimental-vm-modules',
          '--max-old-space-size=256'
        ].filter(Boolean),
        serialization: 'json',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'pipe', 'pipe']
      })
    } catch (error) {
      this.#closeObserverRegistry()
      this.#engineGateConfiguration = undefined
      this.#setState('failed')
      throw error
    }
    this.#child = child
    this.#bindChild(child, this.#generation)
    this.#bindEngineGate(child, this.#generation, session)
    try {
      const value = await this.#request('start', wireNodeRuntimeSessionV1(session))
      this.#setState(value?.state === 'waiting_for_debugger' ? 'waiting_for_debugger' : 'running')
      return value
    } catch (error) {
      await this.#terminateChild(child)
      this.#closeObserverRegistry()
      if (!['stopped', 'stopping'].includes(this.#state)) this.#setState('failed')
      throw error
    }
  }

  async restart(input = this.#session) {
    if (input == null) throw adapterError('session_unavailable')
    await this.stop()
    return this.start(input)
  }

  async resume() {
    if (this.#state !== 'waiting_for_debugger') throw adapterError('invalid_state')
    const value = await this.#request('resume')
    this.#setState('running')
    return value
  }

  async setRules(rules, revision = this.#rulesRevision + 1) {
    if (this.#state !== 'running') throw adapterError('invalid_state')
    const normalized = normalizeNetworkRules(rules)
    const value = await this.#request('rules', { revision, rules: normalized })
    this.#rulesRevision = revision
    return value
  }

  async setRuntimePlugins(runtimePlugins, expectedRevision, revision = expectedRevision + 1) {
    if (this.#state !== 'running') throw adapterError('invalid_state')
    const normalized = normalizeNodeRuntimePluginUpdateV1(runtimePlugins)
    const value = await this.#request('plugins', { expectedRevision, revision, runtimePlugins: normalized })
    this.#session = Object.freeze({
      ...this.#session,
      pluginGraphRevision: revision,
      runtimePlugins: normalized
    })
    return value
  }

  async status() {
    if (this.#child == null) return { generation: this.#generation, state: this.#state }
    return this.#request('status')
  }

  stop() {
    if (this.#stopPromise != null) return this.#stopPromise
    this.#stopPromise = this.#stop().finally(() => {
      this.#stopPromise = undefined
    })
    return this.#stopPromise
  }

  async #stop() {
    const child = this.#child
    if (child == null) {
      if (this.#state !== 'idle') this.#setState('stopped')
      return
    }
    this.#setState('stopping')
    this.#cancelEngineGateRequests(child, this.#generation, 'runtime.cancelled', true)
    try {
      await this.#request('stop')
    } catch {
      // A stopped or crashed child is already terminal.
    }
    await this.#terminateChild(child)
    if (this.#child === child) this.#child = undefined
    this.#closeObserverRegistry()
    this.#setState('stopped')
  }

  #bindChild(child, generation) {
    child.on('message', message => this.#onMessage(child, generation, message))
    child.once('exit', (code, signal) => this.#onExit(child, generation, code, signal))
    child.stdout?.setEncoding('utf8').on('data', text => {
      this.emit('log', { generation, level: 'stdout', text: String(text).slice(0, 65_536) })
    })
    child.stderr?.setEncoding('utf8').on('data', text => {
      this.emit('log', { generation, level: 'stderr', text: String(text).slice(0, 65_536) })
    })
  }

  #bindEngineGate(child, generation, session) {
    const requests = child.stdio[4]
    const responses = child.stdio[5]
    if (requests == null || responses == null) return
    let buffered = Buffer.alloc(0)
    const policyDigest = session.capabilityRuntime == null
      ? '0'.repeat(64)
      : compileSandboxPolicyV2(
        session.capabilityRuntime.runtimeCreation.configuration.sandboxPolicy
      ).digest
    const processId = session.capabilityRuntime?.processId ?? 'node-runtime'
    const codeGeneration = session.capabilityRuntime?.runtimeCreation.configuration.sandboxPolicy.codeGeneration
    const diagnostics = session.capabilityRuntime?.runtimeCreation.configuration.sandboxPolicy.diagnostics
    this.#engineGateConfiguration = Object.freeze({ codeGeneration, diagnostics, generation, policyDigest, processId })
    requests.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length > 16 * 1024 * 1024 + 1024) {
        child.kill('SIGTERM')
        return
      }
      while (true) {
        const newline = buffered.indexOf(0x0A)
        if (newline < 0) break
        const line = buffered.subarray(0, newline).toString('ascii')
        const match = /^HGE2 (\d+) ([SW]) ([01]) (\d+)$/u.exec(line)
        if (match == null) {
          child.kill('SIGTERM')
          return
        }
        const [, nativeRequestId, kind, , sourceBytesText] = match
        const sourceBytes = Number(sourceBytesText)
        if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0 || sourceBytes > 16 * 1024 * 1024) {
          child.kill('SIGTERM')
          return
        }
        if (buffered.length < newline + 1 + sourceBytes) break
        const source = Buffer.from(buffered.subarray(newline + 1, newline + 1 + sourceBytes))
        buffered = buffered.subarray(newline + 1 + sourceBytes)
        const request = {
          codeKind: kind === 'S' ? 'strings' : 'wasm',
          metadataSupport: Object.freeze({
            callsite: 'unavailable',
            entryDetail: 'unavailable',
            origin: 'unavailable',
            source: 'unavailable'
          }),
          operation: kind === 'S' ? 'runtime.code.generate.strings' : 'runtime.code.generate.wasm',
          requestId: `node-${generation}-${nativeRequestId}`,
          runtime: Object.freeze({ generation, policyDigest, processId }),
          schemaVersion: 1
        }
        const timeoutMs = kind === 'S'
          ? codeGeneration?.strings.decisionTimeoutMs ?? 1
          : codeGeneration?.wasm.decisionTimeoutMs ?? 1
        this.#dispatchEngineGateRequest({
          child,
          generation,
          request,
          respond: decision => responses.write(`HGE1 ${nativeRequestId} ${decision.action}\n`),
          source,
          timeoutMs
        })
      }
    })
    requests.on('error', () => undefined)
    responses.on('error', () => undefined)
  }

  #dispatchEngineGateRequest({ child, generation, request, respond, source, timeoutMs }) {
    const sourceBuffer = source == null ? undefined : Buffer.from(source)
    const sourceMetadata = sourceBuffer == null
      ? request
      : {
        ...request,
        metadataSupport: Object.freeze({ ...request.metadataSupport, source: 'available' }),
        sourceBytes: sourceBuffer.byteLength,
        sourceSha256: createHash('sha256').update(sourceBuffer).digest('hex')
      }
    let metadata
    try {
      metadata = normalizeEngineGateRequestMetadataV1(sourceMetadata)
    } catch {
      child.kill('SIGTERM')
      return
    }
    const key = metadata.requestId
    const controller = new AbortController()
    const sourceReader = this.#createSourceReader(sourceBuffer, controller.signal, generation)
    const finish = decision => {
      const pending = this.#engineGatePending.get(key)
      if (pending == null) return
      clearTimeout(pending.timeout)
      this.#engineGatePending.delete(key)
      sourceReader?.close()
      if (child !== this.#child || generation !== this.#generation) return
      respond(decision)
    }
    const timeout = setTimeout(() => {
      controller.abort(adapterError('engine_gate_timeout'))
      finish({ action: 'deny', reasonCode: 'runtime.timeout' })
    }, timeoutMs)
    this.#engineGatePending.set(key, {
      child,
      closeSource: sourceReader?.close,
      controller,
      finish,
      generation,
      timeout
    })
    const hostRequest = Object.freeze({
      ...metadata,
      ...(sourceReader == null ? {} : { sourceReader: sourceReader.reader }),
      signal: controller.signal
    })
    void Promise.resolve()
      .then(() => this.#engineGate?.(hostRequest) ?? { action: 'deny', reasonCode: 'host.gate_unavailable' })
      .then(decision => normalizeEngineGateDecisionV1(decision))
      .catch(() => ({ action: 'deny', reasonCode: 'host.gate_failed' }))
      .then(finish)
  }

  #onModuleEngineGate(child, generation, event) {
    const configuration = this.#engineGateConfiguration
    if (configuration == null || configuration.generation !== generation) {
      child.kill('SIGTERM')
      return
    }
    const dynamicImport = configuration.codeGeneration?.dynamicImport
    if (dynamicImport?.access !== 'controlled') {
      child.kill('SIGTERM')
      return
    }
    if (
      event.request == null || typeof event.request !== 'object' || Array.isArray(event.request) ||
      event.request.codeKind !== 'module' ||
      event.request.operation !== 'runtime.module.import' ||
      event.request.entryDetail?.kind !== 'dynamicImport' ||
      event.request.entryDetail?.source !== 'loader' ||
      typeof event.request.requestId !== 'string' || event.request.requestId.length > 256 ||
      typeof event.request.source !== 'string'
    ) {
      child.kill('SIGTERM')
      return
    }
    const { source, ...eventRequest } = event.request
    const request = {
      ...eventRequest,
      runtime: Object.freeze({
        generation,
        policyDigest: configuration.policyDigest,
        processId: configuration.processId
      })
    }
    this.#dispatchEngineGateRequest({
      child,
      generation,
      request,
      respond: decision => {
        if (!child.connected) return
        child.send(
          createParentCommand('engineGateDecision', ++this.#requestId, generation, {
            action: decision.action,
            requestId: event.request?.requestId
          }),
          () => undefined
        )
      },
      source: typeof source === 'string' ? Buffer.from(source) : undefined,
      timeoutMs: dynamicImport.decisionTimeoutMs
    })
  }

  #cancelEngineGateRequests(child, generation, reasonCode, respond) {
    for (const [key, pending] of [...this.#engineGatePending]) {
      if (pending.child !== child || pending.generation !== generation) continue
      pending.controller.abort(adapterError(reasonCode))
      if (respond) pending.finish({ action: 'deny', reasonCode })
      else {
        clearTimeout(pending.timeout)
        pending.closeSource?.()
        this.#engineGatePending.delete(key)
      }
    }
  }

  #closeObserverRegistry() {
    this.#observerRegistry?.close()
    this.#observerRegistry = undefined
  }

  #createSourceReader(source, signal, generation) {
    const diagnostics = this.#engineGateConfiguration?.diagnostics
    const limit = Math.min(
      diagnostics?.sourceReader === 'boundedSource' ? diagnostics.maxSourceReadBytes : 0,
      this.#sourceReaderHostCaps.maxReadBytes,
      source?.byteLength ?? 0
    )
    if (source == null || limit < 1) return undefined
    let active = true
    let consumed = false
    return {
      close: () => {
        active = false
      },
      reader: Object.freeze({
        read: async options => {
          if (
            !active || consumed || signal.aborted || generation !== this.#generation ||
            options == null || typeof options !== 'object' || Array.isArray(options) ||
            Object.keys(options).some(key => key !== 'maxBytes') ||
            !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1
          ) throw adapterError('engine_source_reader_unavailable')
          consumed = true
          const bytes = Math.min(options.maxBytes, limit)
          return Uint8Array.from(source.subarray(0, bytes))
        }
      })
    }
  }

  #createObserverRegistry(session, generation) {
    const references = session.capabilityRuntime?.runtimeCreation.hostBindings.initialObservers ?? []
    if (references.length === 0) return undefined
    const diagnostics = session.capabilityRuntime.runtimeCreation.configuration.sandboxPolicy.diagnostics
    const registry = new RuntimeObserverRegistryV1({
      generation,
      hostCaps: this.#observerHostCaps,
      onDiagnostic: diagnostic => this.emit('observerDiagnostic', Object.freeze({ generation, ...diagnostic })),
      platform: NODE_RUNTIME_OBSERVER_PLATFORM_V1,
      policy: diagnostics
    })
    try {
      for (const reference of references) {
        const binding = this.#observerBindings.get(reference.bindingId)
        if (
          binding == null || binding.ownerId !== reference.ownerId ||
          binding.version !== reference.version
        ) throw adapterError('observer_binding_unavailable')
        registry.subscribe(binding.registration, binding.observer)
      }
      return registry
    } catch (error) {
      registry.close()
      throw error
    }
  }

  #onObserver(child, event) {
    try {
      this.#observerRegistry?.publish(event.event, event.payload, event.correlationId)
    } catch {
      child.kill('SIGTERM')
    }
  }

  #onMessage(child, generation, message) {
    if (child !== this.#child || generation !== this.#generation) return
    const event = readChildEvent(message, generation)
    if (event == null) return
    if (event.type === 'engineGate') return this.#onModuleEngineGate(child, generation, event)
    if (event.type === 'observer') return this.#onObserver(child, event)
    if (event.type === 'ack') {
      const pending = this.#pending.get(event.requestId)
      if (pending == null) return
      clearTimeout(pending.timeout)
      this.#pending.delete(event.requestId)
      event.ok ? pending.resolve(event.value) : pending.reject(adapterError(event.error?.code ?? 'request_failed'))
      return
    }
    if (event.type === 'state') this.#setState(event.state)
    this.emit(event.type, event)
  }

  #onExit(child, generation, code, signal) {
    if (child !== this.#child || generation !== this.#generation) return
    if (!this.#requestedTermination.has(child) && !['stopping', 'stopped'].includes(this.#state)) {
      this.emit('exit', Object.freeze({ code, generation, signal }))
    }
    this.#cancelEngineGateRequests(child, generation, 'runtime.disconnected', false)
    this.#engineGateConfiguration = undefined
    this.#closeObserverRegistry()
    this.#child = undefined
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(adapterError('child_exited'))
    }
    this.#pending.clear()
    if (!['stopped', 'stopping', 'failed'].includes(this.#state)) this.#setState('failed')
  }

  #request(type, value, timeoutMs = this.#timeoutMs) {
    const child = this.#child
    if (child == null || !child.connected) return Promise.reject(adapterError('child_unavailable'))
    const requestId = ++this.#requestId
    return new Promise((resolve, reject) => {
      const timeout = timeoutMs === 0
        ? undefined
        : setTimeout(() => {
          this.#pending.delete(requestId)
          reject(adapterError('request_timeout'))
        }, timeoutMs)
      this.#pending.set(requestId, { reject, resolve, timeout })
      child.send(createParentCommand(type, requestId, this.#generation, value), error => {
        if (error == null) return
        clearTimeout(timeout)
        this.#pending.delete(requestId)
        reject(adapterError('ipc_send_failed'))
      })
    })
  }

  async #terminateChild(child) {
    if (child.exitCode != null || child.signalCode != null) return
    this.#requestedTermination.add(child)
    this.#cancelEngineGateRequests(child, this.#generation, 'runtime.cancelled', true)
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
  }

  #setState(state) {
    if (this.#state === state) return
    this.#state = state
    this.emit('state', { generation: this.#generation, state })
  }
}
