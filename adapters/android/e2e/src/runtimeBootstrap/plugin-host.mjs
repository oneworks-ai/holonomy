import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel'
import { Context } from 'cordis'
import { runtimePluginNamespaces } from 'holo-plugins:///manifest.mjs'

import { createAndroidCapabilityHostRuntime } from './capability-host-runtime.mjs'
import { WebAbortController, WebAbortSignal } from './modules/web-network/web-abort.js'
import { installAndroidPluginTimers } from './plugin-timers.mjs'
import { RuntimeURL, RuntimeURLSearchParams } from './runtime-web-standards.mjs'

const host = globalThis.__oneworksAndroidPluginHost
if (host == null) throw new Error('Android Runtime plugin Host is unavailable')
const disposePluginTimers = installAndroidPluginTimers(host)
Object.defineProperties(globalThis, {
  AbortController: {
    configurable: false,
    enumerable: false,
    value: WebAbortController,
    writable: false
  },
  AbortSignal: {
    configurable: false,
    enumerable: false,
    value: WebAbortSignal,
    writable: false
  },
  URL: {
    configurable: false,
    enumerable: false,
    value: RuntimeURL,
    writable: false
  },
  URLSearchParams: {
    configurable: false,
    enumerable: false,
    value: RuntimeURLSearchParams,
    writable: false
  }
})
const bundles = JSON.parse(host.runtimePlugins())
const capabilityRuntime = createAndroidCapabilityHostRuntime(host, bundles.length === 0 ? 0 : 1)
const definitions = bundles.map(bundle => ({
  bundleSha256: bundle.bundleSha256,
  config: bundle.config,
  entryUrl: bundle.entryUrl,
  exportName: bundle.exportName,
  instanceId: bundle.instanceId
}))

Object.defineProperty(globalThis, 'console', {
  configurable: false,
  enumerable: false,
  value: Object.freeze({
    error: (...values) => host.writeOutput('stderr', `${values.map(String).join(' ')}\n`),
    log: (...values) => host.writeOutput('stdout', `${values.map(String).join(' ')}\n`),
    warn: (...values) => host.writeOutput('stderr', `${values.map(String).join(' ')}\n`)
  }),
  writable: false
})

const disposers = []
const scopes = []
const collect = effect => {
  if (effect == null) return
  if (typeof effect === 'function') {
    disposers.push(effect)
    return
  }
  if (typeof effect === 'object' && 'then' in effect) {
    Promise.resolve(effect).catch(() => undefined)
    throw new TypeError('Android Runtime plugin initialization must be synchronous')
  }
  if (typeof effect === 'object' && Symbol.iterator in effect) {
    for (const dispose of effect) collect(dispose)
    return
  }
  throw new TypeError('Android Runtime plugin returned an invalid effect')
}
for (const definition of definitions) {
  const identity = `${definition.entryUrl}?holo-bundle=${definition.bundleSha256}`
  const namespace = runtimePluginNamespaces[identity]
  if (namespace == null) throw new Error('Android Runtime plugin namespace is unavailable')
  const plugin = namespace[definition.exportName]
  const scope = capabilityRuntime?.createPluginInterceptorScope(definition.instanceId)
  if (scope != null) scopes.push(scope)
  const context = new Context().extend({
    holo: Object.freeze({
      deny: invocation => {
        throw new CapabilityInvocationError(
          'middleware.permission_denied',
          invocation.operation,
          invocation.resource.requested.semanticResourceDigest
        )
      },
      instanceId: definition.instanceId,
      intercept: (matcher, middleware, options = {}) => {
        if (scope == null) throw new Error('Android Capability interception is unavailable')
        if (typeof middleware !== 'function') throw new TypeError('Capability middleware is invalid')
        if (options.execution != null && options.execution !== 'sync') {
          throw new TypeError('Android Runtime plugins require synchronous Capability middleware')
        }
        return scope.use(matcher, middleware, { ...options, execution: 'sync' })
      }
    })
  })
  const effect = typeof plugin === 'function'
    ? plugin(context, definition.config)
    : plugin?.apply?.(context, definition.config)
  collect(effect)
}
if (capabilityRuntime != null && scopes.length > 0) {
  capabilityRuntime.publishPluginGraph(capabilityRuntime.pluginGraphRevision, scopes)
}

const unavailable = JSON.stringify({
  error: {
    code: 'ERR_HOLO_CAPABILITY_UNSUPPORTED',
    message: 'Capability Runtime is unavailable',
    name: 'Error',
    retryable: false
  },
  ok: false
})
const sourceInput = source => {
  const input = JSON.parse(source)
  if (Array.isArray(input.bytes)) input.bytes = new Uint8Array(input.bytes)
  return input
}
const sourceResult = value =>
  value instanceof Uint8Array
    ? { bytes: [...value], kind: 'bytes' }
    : { kind: 'value', value }
const sourceTerminal = async (channel, source) => {
  try {
    if (capabilityRuntime == null) {
      throw Object.assign(new Error('Capability Runtime is unavailable'), {
        code: 'runtime.capability_unsupported'
      })
    }
    return JSON.stringify({
      ok: true,
      result: sourceResult(await capabilityRuntime.invokeFromSource(channel, sourceInput(source)))
    })
  } catch (error) {
    return JSON.stringify({
      error: {
        code: typeof error?.code === 'string' ? error.code : 'runtime.internal',
        ...(Number.isInteger(error?.errno) ? { errno: error.errno } : {}),
        message: typeof error?.message === 'string' ? error.message : 'Capability invocation failed',
        ...(typeof error?.operation === 'string' ? { operation: error.operation } : {})
      },
      ok: false
    })
  }
}

globalThis.__oneworksAndroidCapabilityInvoke = (json, initiallyAborted) => {
  if (capabilityRuntime == null) return Promise.resolve(unavailable)
  return initiallyAborted === true
    ? capabilityRuntime.cancel(json)
    : capabilityRuntime.invokeImmediate(json)
}
globalThis.__oneworksAndroidCapabilityInvokeImmediate = json => capabilityRuntime?.invokeImmediate(json) ?? unavailable
globalThis.__oneworksAndroidCapabilityInvokeSync = json => capabilityRuntime?.invokeSync(json) ?? unavailable
globalThis.__oneworksAndroidCapabilityInvokeFromSource = sourceTerminal
globalThis.__oneworksAndroidCapabilityReleaseResource = bindingId => {
  capabilityRuntime?.releaseResource(bindingId)
  return capabilityRuntime != null
}
globalThis.__oneworksAndroidCapabilitySubscribeResource = (bindingId, subscriptionId) => {
  if (capabilityRuntime == null) return false
  const dispose = capabilityRuntime.subscribeResource(
    bindingId,
    eventJson => host.emitGuestResourceEvent(subscriptionId, eventJson)
  )
  host.retainGuestResourceSubscription(subscriptionId, dispose)
  return true
}
globalThis.__oneworksAndroidCapabilityUnsubscribeResource = subscriptionId =>
  host.releaseGuestResourceSubscription(subscriptionId)
globalThis.__oneworksAndroidCapabilityClose = () => capabilityRuntime?.close()
globalThis.__oneworksAndroidPluginDispose = () => {
  disposePluginTimers()
  capabilityRuntime?.close()
  for (const dispose of disposers.splice(0).reverse()) {
    const result = dispose()
    if (result != null && typeof result === 'object' && 'then' in result) {
      Promise.resolve(result).catch(() => undefined)
    }
  }
  for (const scope of scopes.splice(0).reverse()) scope.dispose()
}
delete globalThis.__oneworksAndroidPluginHost
