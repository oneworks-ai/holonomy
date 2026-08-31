/* eslint-disable max-lines -- supervisor lifecycle and its exact IPC request fencing stay co-located. */

import { fork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import process from 'node:process'

import { verifyInstalledV86ProcessProfileV1 } from './capability-process-v86-installation.mjs'
import { normalizeNodeRuntimePluginUpdateV1 } from './capability-runtime-plugins.mjs'
import { createParentCommand, readChildEvent } from './protocol.mjs'
import { prepareHolonomyNodeSession } from './runtime-assets.mjs'
import { normalizeNetworkRules, normalizeNodeRuntimeSession } from './session-validation.mjs'
import { wireNodeRuntimeSessionV1 } from './supervisor-session.mjs'

const CHILD_URL = new URL('./child-runtime.mjs', import.meta.url)

const adapterError = code => Object.assign(new Error(`Node adapter ${code}`), { code })
export class NodeRuntimeSupervisor extends EventEmitter {
  #child
  #generation = 0
  #pending = new Map()
  #requestId = 0
  #rulesRevision = 0
  #session
  #state = 'idle'
  #stopPromise
  #timeoutMs

  constructor({ requestTimeoutMs = 10_000 } = {}) {
    super()
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
    this.#session = Object.freeze(wireNodeRuntimeSessionV1(replayableSession))
    this.#generation += 1
    this.#rulesRevision = 0
    this.#setState('starting')
    const child = fork(CHILD_URL, [], {
      env: {
        NODE_NO_WARNINGS: '1',
        ...(process.env.HOLO_V86_TRACE === '1' ? { HOLO_V86_TRACE: '1' } : {})
      },
      execArgv: [
        session.inspector.enabled ? '--inspect=127.0.0.1:0' : '',
        '--experimental-vm-modules',
        '--max-old-space-size=256'
      ].filter(Boolean),
      serialization: 'json',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    this.#child = child
    this.#bindChild(child, this.#generation)
    try {
      const value = await this.#request('start', wireNodeRuntimeSessionV1(session))
      this.#setState(value?.state === 'waiting_for_debugger' ? 'waiting_for_debugger' : 'running')
      return value
    } catch (error) {
      await this.#terminateChild(child)
      this.#setState('failed')
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
    try {
      await this.#request('stop')
    } catch {
      // A stopped or crashed child is already terminal.
    }
    await this.#terminateChild(child)
    if (this.#child === child) this.#child = undefined
    this.#setState('stopped')
  }

  #bindChild(child, generation) {
    child.on('message', message => this.#onMessage(child, generation, message))
    child.once('exit', () => this.#onExit(child, generation))
    child.stdout?.setEncoding('utf8').on('data', text => {
      this.emit('log', { generation, level: 'stdout', text: String(text).slice(0, 65_536) })
    })
    child.stderr?.setEncoding('utf8').on('data', text => {
      this.emit('log', { generation, level: 'stderr', text: String(text).slice(0, 65_536) })
    })
  }

  #onMessage(child, generation, message) {
    if (child !== this.#child || generation !== this.#generation) return
    const event = readChildEvent(message, generation)
    if (event == null) return
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

  #onExit(child, generation) {
    if (child !== this.#child || generation !== this.#generation) return
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
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
  }

  #setState(state) {
    if (this.#state === state) return
    this.#state = state
    this.emit('state', { generation: this.#generation, state })
  }
}
