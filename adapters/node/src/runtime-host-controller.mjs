/* eslint-disable max-lines -- one Host bridge owns the callbacks installed into a Runtime generation. */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import vm from 'node:vm'

import { NodeCapabilityRuntimeHostV1 } from './capability-host.mjs'
import { createNodeNetworkPort } from './node-network-transport.mjs'
import { createRuntimeConfiguration } from './runtime-configuration.mjs'
import { createNativeEventValue, installRuntimeHostBridge } from './runtime-context.mjs'
import { NodeRuntimePluginHostV1 } from './runtime-plugin-host.mjs'
import { cancelRuntimeTimer } from './runtime-timers.mjs'

export class NodeRuntimeHostController {
  #disposeGuest
  #capabilityRuntime
  #emitLog
  #emitNetwork
  #eventLoopWakeup
  #graph
  #nativePort
  #nextTimerId = 1
  #plugins
  #ruleUpdater
  #runtimeContext
  #session
  #timerFire
  #timers = new Map()
  #turn
  #userModules

  constructor({ emitLog, emitNetwork, generation, graph, runtimeContext, session }) {
    this.#emitLog = emitLog
    this.#emitNetwork = emitNetwork
    this.#graph = graph
    this.#runtimeContext = runtimeContext
    this.#session = session
    this.#plugins = new NodeRuntimePluginHostV1(graph, session)
    this.#capabilityRuntime = session.capabilityRuntime == null
      ? undefined
      : new NodeCapabilityRuntimeHostV1({ generation, session: session.capabilityRuntime })
    this.#userModules = new Map(session.userModules.map(module => [module.url, module.source]))
    this.#nativePort = createNodeNetworkPort(session.sandboxPlan, this.#emitNetwork)
    installRuntimeHostBridge(runtimeContext, this.#operations())
  }

  async dispose() {
    await this.#capabilityRuntime?.close()
    clearTimeout(this.#eventLoopWakeup)
    for (const timer of this.#timers.values()) {
      if (timer.interval) clearInterval(timer.handle)
      else clearTimeout(timer.handle)
    }
    this.#timers.clear()
    this.#nativePort?.dispose()
    if (this.#disposeGuest != null) await this.#invoke(this.#disposeGuest)
  }

  updateRules(rules) {
    if (this.#ruleUpdater == null) throw new Error('Node Runtime rule updater is unavailable')
    return this.#invoke(this.#ruleUpdater, [JSON.stringify(rules)])
  }

  async updatePlugins(runtimePlugins, expectedRevision, revision) {
    return await this.#plugins.update(runtimePlugins, expectedRevision, revision, (callback, args) => (
      this.#invoke(callback, args)
    ))
  }

  #configuration() {
    return createRuntimeConfiguration(this.#session)
  }

  #invoke(callback, args = []) {
    const result = Reflect.apply(callback, undefined, args)
    vm.runInContext('', this.#runtimeContext.context)
    return result
  }

  #operations() {
    return Object.freeze({
      capabilityConfiguration: () => this.#capabilityRuntime?.configuration() ?? null,
      capabilityInvoke: (json, callback) => {
        if (this.#capabilityRuntime == null || typeof callback !== 'function') return null
        this.#capabilityRuntime.invoke(json, terminal => this.#invoke(callback, [terminal]))
        return true
      },
      capabilityInvokeImmediate: json => this.#capabilityRuntime?.invokeImmediate(json) ?? null,
      capabilityInvokeSync: json => this.#capabilityRuntime?.invokeSync(json) ?? null,
      capabilityReleaseResource: bindingId => this.#capabilityRuntime?.releaseResource(bindingId) ?? false,
      capabilitySubscribeResource: (bindingId, callback) => {
        if (this.#capabilityRuntime == null || typeof callback !== 'function') return null
        return this.#capabilityRuntime.subscribeResource(bindingId, event => this.#invoke(callback, [event]))
      },
      cancelNative: callToken => this.#nativePort?.cancel(callToken),
      cancelTimer: timerId => cancelRuntimeTimer(this.#timers, timerId),
      closeNativeResource: (owner, provider) => this.#nativePort?.closeResource(owner, provider),
      configuration: () => this.#configuration(),
      disposeNative: () => this.#nativePort?.dispose(),
      grantNativeCredits: (callToken, credits) => this.#nativePort?.grantCredits(callToken, credits),
      installSyntheticModules: registry => {
        this.#graph.installSyntheticModules(registry)
        return true
      },
      nativeDispatch: (request, context, sink, resourceSink) => {
        if (this.#nativePort == null) {
          this.#invokeNativeEvent(sink, {
            error: { code: 'capability_unsupported' },
            id: request.id,
            type: 'error'
          })
          return
        }
        this.#nativePort.dispatch(
          request,
          context,
          event => this.#invokeNativeEvent(sink, event),
          event => this.#invokeNativeEvent(resourceSink, event)
        )
      },
      networkDiagnostic: json => {
        try {
          this.#emitNetwork({ layer: 'fetch', ...JSON.parse(json) })
        } catch {
          // Diagnostics are lossy and never affect Fetch.
        }
      },
      now: () => performance.now(),
      onError: (name, error) =>
        this.#emitLog({
          level: 'error',
          text: `Node host operation failed: ${name}: ${error?.message ?? 'unknown'}`
        }),
      readModule: url => this.#readModule(url),
      registerDispose: callback => {
        this.#disposeGuest = callback
        return true
      },
      registerPluginUpdater: callback => {
        return this.#plugins.register(callback)
      },
      registerRuleUpdater: callback => {
        this.#ruleUpdater = callback
        return true
      },
      registerTimerFire: callback => {
        this.#timerFire = callback
        return true
      },
      registerTurn: callback => {
        this.#turn = callback
        return true
      },
      requestWakeup: deadline => this.#requestWakeup(deadline),
      scheduleTimer: (delay, interval) => this.#scheduleTimer(delay, interval),
      sha256Chunks: chunks => this.#sha256Chunks(chunks),
      terminate: reason => this.#emitLog({ level: 'error', text: `Runtime terminated: ${String(reason)}` }),
      writeOutput: (level, text) => this.#emitLog({ level, text: String(text).slice(0, 65_536) })
    })
  }

  #readModule(url) {
    const source = this.#userModules.get(url)
    if (source == null) return null
    const bytes = Buffer.from(source, 'utf8')
    return JSON.stringify({
      base64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
  }

  #invokeNativeEvent(sink, event) {
    return this.#invoke(sink, [createNativeEventValue(this.#runtimeContext, event)])
  }

  #requestWakeup(deadline) {
    clearTimeout(this.#eventLoopWakeup)
    const delay = Math.max(0, Math.ceil(deadline - performance.now()))
    this.#eventLoopWakeup = setTimeout(() => {
      if (this.#turn != null) this.#invoke(this.#turn)
    }, delay)
  }

  #scheduleTimer(delay, interval) {
    const id = this.#nextTimerId++
    const fire = () => {
      if (interval == null) this.#timers.delete(id)
      if (this.#timerFire != null) this.#invoke(this.#timerFire, [id])
    }
    const handle = interval == null ? setTimeout(fire, delay) : setInterval(fire, interval)
    this.#timers.set(id, { handle, interval: interval != null })
    return id
  }

  #sha256Chunks(chunks) {
    const limit = Math.min(
      this.#session.sandboxPlan.authority?.limits.maxRequestBodyBytes ?? 1024 * 1024,
      16 * 1024 * 1024
    )
    if (!Array.isArray(chunks) || chunks.length > 4_096) throw new TypeError('Invalid digest chunks')
    const digest = createHash('sha256')
    let total = 0
    for (const chunk of chunks) {
      if (!ArrayBuffer.isView(chunk) || chunk.BYTES_PER_ELEMENT !== 1) throw new TypeError('Invalid digest chunk')
      total += chunk.byteLength
      if (total > limit) throw new RangeError('Digest input exceeds the limit')
      digest.update(chunk)
    }
    return digest.digest('hex')
  }
}
