/* eslint-disable max-lines -- Profile planning and executor lifecycle form one private Host boundary. */
import {
  normalizeRuntimePluginBundlesV1,
  runtimePluginBundleDigestV1
} from '../../../../packages/runtime/src/app/index.ts'
import {
  compileRuntimeObserverAdmissionV1,
  normalizeRuntimeObserverEventV1
} from '../../../../packages/runtime/src/kernel/index.ts'
import { utf8ByteLength } from '../../../../packages/runtime/src/kernel/validation.ts'
import { HolonomyModuleLoader } from '../../../../packages/runtime/src/module-loader/index.ts'

import {
  NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1,
  NATIVE_RUNTIME_OBSERVER_PLATFORM_V1
} from './native-observer-platform.mjs'

const MAX_MODULE_BYTES = 1024 * 1024
const MAX_GRAPH_BYTES = 4 * 1024 * 1024
const MAX_PLAN_BYTES = 32 * 1024 * 1024
const MAX_MODULES = 128
const READY_POLL_MS = 10
// The executor permits three initialization attempts of up to 2 s each.
// One additional second covers bounded spawn/reap and Host timer dispatch.
const READY_TOTAL_MS = 7_000
const MAX_EVENT_BYTES = 8 * 1024

// This leaf plans diagnostic modules in the trusted Host Context. Only the
// separate native executor may instantiate or evaluate their source.
export const createNativeObserverProfilesV1 = (native, policy, observers) => {
  let candidates = []
  let prepared = false
  let ready = false
  let subscribed = false
  let closed = false
  let pendingTimer
  let rejectPending
  const subscriptions = []

  const readModule = id => url => {
    const source = native.observerProfileSource(id, url)
    if (source === null) return null
    const parsed = JSON.parse(source)
    return Object.freeze({ bytes: new Uint8Array(parsed.bytes), sha256: parsed.sha256 })
  }
  const validateIdentity = installation => {
    const id = installation?.id
    const module = installation?.module
    if (
      typeof id !== 'string' || id.length < 1 || id.length > 64 ||
      !/^[A-Za-z0-9][\w.-]*$/u.test(id) ||
      module?.instanceId !== `observer.${id}` ||
      module.rootUrl !== `holo-plugins:///observer.${id}/` ||
      typeof module.entryUrl !== 'string' || !module.entryUrl.startsWith(module.rootUrl)
    ) throw new Error('Native Observer profile identity is invalid')
    return id
  }
  const prepareOne = async installation => {
    const { id, module, registration } = installation
    const admission = compileRuntimeObserverAdmissionV1(
      registration,
      policy.diagnostics,
      NATIVE_RUNTIME_OBSERVER_PLATFORM_V1,
      NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1
    )
    if (admission.callbackTimeoutMs < 1 || admission.maxQueuedEvents < 1) {
      throw new Error('Native Observer profile has no effective budget')
    }
    const loader = new HolonomyModuleLoader(
      Object.freeze({ readModule: readModule(id), syntheticNodeModules: Object.freeze({}) }),
      Object.freeze({ rootUrl: module.rootUrl, captureDynamicImports: true })
    )
    const plan = await loader.createPlan(module.entryUrl)
    if (
      plan.modules.length > MAX_MODULES ||
      plan.modules.some(item => item.source != null && utf8ByteLength(item.source) > MAX_MODULE_BYTES) ||
      plan.modules.reduce((total, item) => total + (item.source == null ? 0 : utf8ByteLength(item.source)), 0) >
        MAX_GRAPH_BYTES
    ) throw new Error('Native Observer profile module graph exceeds bounds')
    if (plan.modules.some(item => item.format !== 'module' || item.source === null || item.sha256 === null)) {
      throw new Error('Native Observer profile module graph is unsupported')
    }
    const raw = Object.freeze({
      config: module.config,
      ...(module.configSchema == null ? {} : { configSchema: module.configSchema }),
      entryUrl: module.entryUrl,
      exportName: module.exportName,
      files: Object.freeze(plan.modules.map(item =>
        Object.freeze({
          sha256: item.sha256,
          source: item.source,
          url: item.url
        })
      )),
      instanceId: module.instanceId,
      rootUrl: module.rootUrl,
      schemaVersion: 1
    })
    const bundleSha256 = runtimePluginBundleDigestV1(raw)
    if (module.integrity != null && module.integrity !== bundleSha256) {
      throw new Error('Native Observer profile integrity mismatch')
    }
    normalizeRuntimePluginBundlesV1([{ ...raw, bundleSha256 }])
    const encodedPlan = JSON.stringify(plan)
    if (utf8ByteLength(encodedPlan) > MAX_PLAN_BYTES) {
      throw new Error('Native Observer profile module plan exceeds bounds')
    }
    return Object.freeze({ admission, id, plan: encodedPlan, bundleSha256, registration })
  }

  const close = () => {
    if (closed) return
    closed = true
    if (pendingTimer !== undefined) native.clear(pendingTimer)
    rejectPending?.(new Error('Native Observer profile setup closed'))
    rejectPending = undefined
    for (const subscription of subscriptions.splice(0)) subscription.dispose()
    native.observerProfilesClose()
  }
  const prepare = async installations => {
    if (closed || prepared) throw new Error('Native Observer profile setup is unavailable')
    if (!Array.isArray(installations) || installations.length > 4) {
      throw new Error('Native Observer profile count is invalid')
    }
    const ids = new Set()
    // Validate every registration and identity before any source read or helper.
    for (const installation of installations) {
      const id = validateIdentity(installation)
      if (ids.has(id)) throw new Error('Duplicate Native Observer profile')
      ids.add(id)
      const admission = compileRuntimeObserverAdmissionV1(
        installation.registration,
        policy.diagnostics,
        NATIVE_RUNTIME_OBSERVER_PLATFORM_V1,
        NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1
      )
      if (admission.callbackTimeoutMs < 1 || admission.maxQueuedEvents < 1) {
        throw new Error('Native Observer profile has no effective budget')
      }
    }
    candidates = []
    for (const installation of installations) candidates.push(await prepareOne(installation))
    prepared = true
  }
  const start = async () => {
    if (closed || !prepared || ready) throw new Error('Native Observer profile setup is unavailable')
    try {
      for (const item of candidates) {
        if (
          native.observerProfileStart(
            item.id,
            item.plan,
            item.bundleSha256,
            item.admission.callbackTimeoutMs,
            item.admission.maxQueuedEvents
          ) !== true
        ) throw new Error('Native Observer profile helper did not start')
      }
      if (candidates.length === 0) {
        ready = true
        return
      }
      const deadline = native.now() + READY_TOTAL_MS
      if (!Number.isFinite(deadline)) throw new Error('Native Observer profile clock is unavailable')
      await new Promise((resolve, reject) => {
        rejectPending = reject
        const poll = () => {
          try {
            pendingTimer = undefined
            if (closed) return reject(new Error('Native Observer profile setup closed'))
            const now = native.now()
            if (!Number.isFinite(now) || now >= deadline) {
              return reject(new Error('Native Observer profile helper readiness timed out'))
            }
            const statuses = candidates.map(item => native.observerProfileStatus(item.id))
            if (statuses.some(status => status === 'failed' || status === 'closed')) {
              return reject(new Error('Native Observer profile helper failed'))
            }
            if (statuses.every(status => status === 'ready')) return resolve()
            if (statuses.some(status => status !== 'starting' && status !== 'ready')) {
              return reject(new Error('Native Observer profile helper readiness timed out'))
            }
            pendingTimer = native.schedule(poll, Math.min(READY_POLL_MS, deadline - now))
          } catch (error) {
            reject(error)
          }
        }
        poll()
      })
      rejectPending = undefined
      ready = true
    } catch (error) {
      close()
      throw error
    }
  }
  const bind = ownerId => {
    if (closed || !ready || subscribed) throw new Error('Native Observer profile binding is unavailable')
    const bindings = new Map()
    const references = []
    for (const item of candidates) {
      const bindingId = `observer.${item.id}`
      const forward = event => {
        if (closed) return
        try {
          const encoded = JSON.stringify(normalizeRuntimeObserverEventV1(event))
          if (utf8ByteLength(encoded) <= MAX_EVENT_BYTES) native.observerProfilePublish(item.id, encoded)
        } catch {
          // Diagnostic delivery is lossy; it must never affect Guest or Gate.
        }
      }
      references.push(Object.freeze({ bindingId, ownerId, version: item.bundleSha256 }))
      bindings.set(bindingId, Object.freeze({ kind: 'native-isolated-observer-forwarder-v1', forward }))
    }
    return Object.freeze({ bindings, references: Object.freeze(references) })
  }
  const subscribe = bindings => {
    if (closed || !ready || subscribed) throw new Error('Native Observer profile subscription is unavailable')
    try {
      for (const item of candidates) {
        const binding = bindings.get(`observer.${item.id}`)
        if (binding == null) throw new Error('Native Observer profile binding is unavailable')
        subscriptions.push(observers.observe(item.registration, binding.forward))
      }
      subscribed = true
    } catch (error) {
      close()
      throw error
    }
  }
  return Object.freeze({ bind, close, prepare, start, subscribe })
}
