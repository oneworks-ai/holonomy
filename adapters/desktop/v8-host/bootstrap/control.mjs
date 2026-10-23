/* eslint-disable max-lines -- Native Host startup composes one Kernel and its gated Providers. */
import { STORAGE_NATIVE_BY_OPERATION_V1 } from '@holonomyjs/capability-storage/kernel/storage-invocation'
import { DEFAULT_ABORT_CONSTRUCTORS } from '../../../../packages/capabilities/network/src/web/index.ts'
import {
  CapabilityRuntimeInvocationKernelV1,
  RuntimeEngineGateRegistryV1,
  admitRuntimeCreationV1,
  canonicalDigest,
  compileHostSystemProjectionV1,
  compileRuntimeContextEnvelopeV1,
  compileSandboxPolicyV2,
  selectCapabilityBranchV1
} from '../../../../packages/runtime/src/kernel/index.ts'
import { utf8ByteLength } from '../../../../packages/runtime/src/kernel/validation.ts'
import { encodeUtf8 } from '../../../../packages/runtime/src/node-compat/encoding.ts'
import { DEFAULT_STORAGE_LIMITS } from '../../../../packages/runtime/src/storage/authority.ts'
import { RuntimeTextDecoder, RuntimeURL, RuntimeURLSearchParams } from '../../../node/src/runtime-web-standards.mjs'

import { createPrivateNativeDesktopDeviceProviderV1 } from './device-provider.mjs'
import { createNativeEngineGate } from './engine-gate.mjs'
import { createNativeRuntimeObserver } from './native-observer.mjs'
import { createNativePort } from './native-port-host.mjs'
import { createNativeNetworkProvider } from './network-provider.mjs'
import { createNativeObserverProfilesV1 } from './observer-profiles.mjs'
import { createNativePluginHost } from './plugins.mjs'
import { createPrivateNativeDarwinProcessProviderV1 } from './process-darwin-installation.mjs'
import { createPrivateNativeV86ProcessProviderV1 } from './process-v86-installation.mjs'
import { createNativeProviders } from './providers.mjs'
import { createNativeResourceSubscriptions } from './resource-subscriptions.mjs'
import { createNativeSourceReadAudit } from './source-read-audit.mjs'
import { createNativeStorageProvider } from './storage-provider.mjs'

const native = globalThis.__holoControlHost
delete globalThis.__holoControlHost
globalThis.URL = RuntimeURL
globalThis.URLSearchParams = RuntimeURLSearchParams
globalThis.TextDecoder = RuntimeTextDecoder
globalThis.TextEncoder = class {
  get encoding() {
    return 'utf-8'
  }
  encode(input = '') {
    return encodeUtf8(String(input))
  }
}
Object.assign(globalThis, DEFAULT_ABORT_CONSTRUCTORS)
globalThis.setTimeout = (callback, delay) => native.schedule(callback, delay)
globalThis.clearTimeout = id => native.clear(id)
globalThis.performance = Object.freeze({ now: () => native.now() })
globalThis.queueMicrotask = callback => {
  if (typeof callback !== 'function') throw new TypeError('Microtask callback must be a function')
  Promise.resolve().then(callback)
}

const configuration = JSON.parse(native.configuration())
if (configuration.storage != null && native.storageReady() !== true) {
  throw new Error('Native Storage installation failed')
}
const policy = compileSandboxPolicyV2(configuration.sandboxPolicy).policy
const storageNamespace = policy.storage.access === 'sandboxed' && configuration.storage != null
  ? policy.storage.namespaces.find(item => item.namespaceId === 'default')
  : undefined
const guestStorageOperations =
  storageNamespace?.operations.filter(operation =>
    configuration.storage.operations.includes(STORAGE_NATIVE_BY_OPERATION_V1[operation])
  ) ?? []
const guestStorageEnabled = guestStorageOperations.length > 0
const guestStorageLimits = !guestStorageEnabled ? undefined : Object.fromEntries(
  Object.keys(DEFAULT_STORAGE_LIMITS).map(key => [
    key,
    Math.min(policy.storage.limits[key], configuration.storage.limits?.[key] ?? policy.storage.limits[key])
  ])
)
const projection = compileHostSystemProjectionV1(configuration.systemProjection)
const context = compileRuntimeContextEnvelopeV1(configuration.context)
const processInstallation = configuration.processBackendInstallation
const privateProcessProfile = configuration.processProfile
const processRequested = policy.process.access === 'sandboxed'
// The Host-private selected profile still needs the compiled sandboxed Policy.
// v86 additionally requires its private experimental installation switch.
const nativeDarwinProcessSelected = privateProcessProfile?.backend?.backendId === 'native.darwin-seatbelt-v1' &&
  (processInstallation == null || processInstallation.backendId === 'native.darwin-seatbelt-v1' &&
      processInstallation.implementation === 'builtin.darwin-seatbelt-v1')
const experimentalNativeV86ProcessSelected = processInstallation?.backendId === 'experimental.v86-v1' &&
  processInstallation.implementation === 'builtin.v86-v1' &&
  processInstallation.experimentalEnable === true
const inspectorInstalled = configuration.inspectorInstalled === true
const sourceReaderInstallation = configuration.diagnosticSourceReader
if (configuration.diagnosticAudit != null && configuration.diagnosticAuditReady !== true) {
  throw new Error('Native diagnostic audit installation is unavailable')
}
const sourceReaderPolicy = policy.diagnostics.sourceReader === 'boundedSource'
if (sourceReaderPolicy !== (sourceReaderInstallation != null)) {
  throw new Error('Native diagnostic source reader capability selection is unavailable')
}
if (sourceReaderInstallation != null && sourceReaderInstallation.capabilityName !== 'host.diagnostics.source.read') {
  throw new Error('Invalid native diagnostic source reader capability selection')
}
const sourceReaderSelectedConstraints = sourceReaderInstallation == null ? undefined : Object.freeze({
  maxReadBytes: Math.min(policy.diagnostics.maxSourceReadBytes, sourceReaderInstallation.maxReadBytes),
  maxReads: sourceReaderInstallation.maxReads
})
const sourceReaderSelection = sourceReaderInstallation == null ? undefined : selectCapabilityBranchV1(
  {
    anyOf: [{
      branchId: 'desktop-source-reader',
      allOf: [{
        name: 'host.diagnostics.source.read',
        version: 1,
        constraints: sourceReaderSelectedConstraints
      }]
    }]
  },
  [{
    name: 'host.diagnostics.source.read',
    version: 1,
    constraints: {
      maxReadBytes: sourceReaderInstallation.maxReadBytes,
      maxReads: sourceReaderInstallation.maxReads
    }
  }],
  {
    generation: 1,
    policyDigest: canonicalDigest(policy),
    principal: 'holo:desktop-runtime:1',
    processId: 'desktop-runtime'
  }
)
const sourceReaderConstraints = sourceReaderSelection?.bindings[0]?.constraints
if (
  sourceReaderInstallation != null && (
    sourceReaderConstraints == null || sourceReaderConstraints.maxReadBytes < 1 || sourceReaderConstraints.maxReads < 1
  )
) throw new Error('Invalid native diagnostic source reader capability selection')
const sourceReaderCaps = Object.freeze({
  auditRead: configuration.diagnosticAudit == null ? undefined : createNativeSourceReadAudit(native),
  maxReadBytes: sourceReaderConstraints == null ? 0 : Math.min(
    policy.diagnostics.maxSourceReadBytes,
    sourceReaderConstraints.maxReadBytes,
    64 * 1024
  ),
  maxReads: sourceReaderConstraints == null ? 0 : Math.min(sourceReaderConstraints.maxReads, 1024)
})
const requestBodyReaderInstallation = configuration.networkRequestBodyReader
const requestBodyInspection = policy.network.requestBodyInspection
if (requestBodyReaderInstallation != null && requestBodyInspection.access !== 'bounded') {
  throw new Error('Native network request body reader is disallowed by Policy')
}
if (
  requestBodyReaderInstallation != null &&
  requestBodyReaderInstallation.capabilityName !== 'host.network.request-body.read'
) throw new Error('Invalid native network request body reader capability selection')
const requestBodyReaderSelectedConstraints = requestBodyReaderInstallation == null ? undefined : Object.freeze({
  maxReadBytes: Math.min(requestBodyInspection.maxBytes, requestBodyReaderInstallation.maxReadBytes),
  maxReads: Math.min(requestBodyInspection.maxReadsPerRuntime, requestBodyReaderInstallation.maxReads)
})
const requestBodyReaderSelection = requestBodyReaderInstallation == null ? undefined : selectCapabilityBranchV1(
  {
    anyOf: [{
      branchId: 'desktop-network-request-body-reader',
      allOf: [{
        name: 'host.network.request-body.read',
        version: 1,
        constraints: requestBodyReaderSelectedConstraints
      }]
    }]
  },
  [{
    name: 'host.network.request-body.read',
    version: 1,
    constraints: {
      maxReadBytes: requestBodyReaderInstallation.maxReadBytes,
      maxReads: requestBodyReaderInstallation.maxReads
    }
  }],
  {
    generation: 1,
    policyDigest: canonicalDigest(policy),
    principal: 'holo:desktop-runtime:1',
    processId: 'desktop-runtime'
  }
)
const requestBodyReaderConstraints = requestBodyReaderSelection?.bindings[0]?.constraints
if (
  requestBodyReaderInstallation != null && (
    requestBodyReaderConstraints == null ||
    requestBodyReaderConstraints.maxReadBytes < 1 ||
    requestBodyReaderConstraints.maxReads < 1
  )
) throw new Error('Invalid native network request body reader capability selection')
const unsupported = {
  process: policy.process.access !== 'none' &&
    !nativeDarwinProcessSelected && !experimentalNativeV86ProcessSelected,
  inspector: Object.values(policy.inspector).some(Boolean) && !inspectorInstalled,
  device: Object.keys(policy.device.operations).length > 0 && configuration.deviceProvider == null
}
if (Object.values(unsupported).some(Boolean)) {
  throw new Error(
    `This native target has not installed ${Object.keys(unsupported).filter(key => unsupported[key]).join(',')}`
  )
}
const installed = JSON.parse(native.filesystem(JSON.stringify({ kind: 'install', filesystem: policy.filesystem })))
if (installed.ok !== true) throw new Error('Native filesystem installation failed')
const networkInstalled = JSON.parse(
  native.networkSync(
    JSON.stringify({ kind: 'install', policy: policy.network, tlsRoots: configuration.networkTrustRoots ?? [] })
  )
)
if (networkInstalled.ok !== true) throw new Error('Native network installation failed')
const network = policy.network.access === 'none' ? undefined : createNativeNetworkProvider(native, policy.network)
const storage = configuration.storage == null
  ? undefined
  : createNativeStorageProvider(native, configuration.storage, policy.storage)
const device = configuration.deviceProvider == null
  ? undefined
  : createPrivateNativeDesktopDeviceProviderV1({
    cancelSchedule: id => native.clear(id),
    nativeDevice: native.device,
    policy: policy.device,
    now: () => native.now(),
    schedule: (callback, delay) => native.schedule(callback, delay)
  })
let kernel
const nativePort = network == null && configuration.storage == null
  ? undefined
  : createNativePort(
    network,
    policy.network,
    configuration.networkRules,
    storage == null
      ? undefined
      : (request, token, signal) => storage.dispatch(request, token, signal, kernel)
  )
let processRuntime
if (processRequested) {
  const processProfile = privateProcessProfile
  if (
    processProfile == null || processInstallation != null &&
      processProfile.backend?.backendId !== processInstallation.backendId
  ) {
    throw new Error('Native Process profile selection is unavailable')
  }
  if (nativeDarwinProcessSelected) {
    if (
      typeof native.darwinProcess !== 'function' ||
      policy.process.mounts.length !== 0 || policy.process.network.access !== 'none' ||
      policy.process.limits.maxWritableRootfsBytes !== 0
    ) throw new Error('Native Darwin Process installation is unavailable')
    processRuntime = createPrivateNativeDarwinProcessProviderV1({
      nativeDarwinProcess: native.darwinProcess,
      generation: 1,
      installation: processInstallation,
      policy: policy.process,
      processProfile
    })
  } else if (experimentalNativeV86ProcessSelected) {
    if (
      typeof native.v86 !== 'function' ||
      policy.process.mounts.length > 1 || policy.process.mounts.some(mount => mount.guestPath !== '/workspace') ||
      policy.process.network.access === 'restricted' &&
        (typeof native.processNetworkSync !== 'function' || typeof native.processNetworkStart !== 'function' ||
          typeof native.processNetworkCancel !== 'function')
    ) throw new Error('Native v86 Process installation is unavailable')
    const pins = processProfile.backend.configuration?.artifacts
    if (pins == null) throw new Error('Native v86 Process artifacts are unavailable')
    processRuntime = createPrivateNativeV86ProcessProviderV1({
      nativeV86: native.v86,
      processNetworkNative: native,
      now: () => native.now(),
      generation: 1,
      installation: {
        root: processInstallation.artifactRoot,
        bios: { sha256: pins.bios?.sha256 },
        kernel: { sha256: pins.kernel?.sha256 },
        initrd: { sha256: pins.initrd?.sha256 }
      },
      policy: policy.process,
      processProfile
    })
  } else {
    throw new Error('Native Process Backend selection is unavailable')
  }
}

let admitted
let subscriptions
const cancellations = new Map()
const engineGates = new RuntimeEngineGateRegistryV1()
const observers = createNativeRuntimeObserver(policy, native)
const observerProfiles = createNativeObserverProfilesV1(native, policy, observers)
const gate = createNativeEngineGate(policy, () => admitted != null, engineGates, sourceReaderCaps, inspectorInstalled)
const plugins = createNativePluginHost(native, engineGates, observers)
export const control = Object.freeze({
  gateConfiguration: () =>
    JSON.stringify({
      schemaVersion: 1,
      stringsTimeoutMs: policy.codeGeneration.strings.access === 'controlled'
        ? policy.codeGeneration.strings.decisionTimeoutMs
        : null,
      wasmTimeoutMs: policy.codeGeneration.wasm.access === 'controlled'
        ? policy.codeGeneration.wasm.decisionTimeoutMs
        : null,
      dynamicImportTimeoutMs: policy.codeGeneration.dynamicImport.access === 'controlled'
        ? policy.codeGeneration.dynamicImport.decisionTimeoutMs
        : null,
      sourceReaderMaxBytes: sourceReaderCaps.maxReadBytes,
      requestBodyReaderMaxBytes: requestBodyReaderConstraints?.maxReadBytes ?? 0,
      observerEvents: policy.diagnostics.observerEvents
    }),
  guestConfiguration: () =>
    JSON.stringify({
      context: context.guest ?? null,
      network: nativePort?.authority,
      storage: !guestStorageEnabled ? undefined : {
        limits: guestStorageLimits,
        operations: guestStorageOperations.map(operation => operation.slice('storage.'.length))
      },
      capabilities: [
        ...(nativePort?.capabilities ?? []),
        ...(guestStorageEnabled ? ['host.storage.v1'] : [])
      ],
      networkRequestBodyReaderMaxBytes: requestBodyReaderConstraints?.maxReadBytes ?? 0,
      ...(processRuntime == null
        ? {}
        : {
          processEnvironment: processRuntime.profile.environment,
          processShellExecutableId: processRuntime.profile.defaultShellExecutableId
        })
    }),
  async prepareObserverProfiles() {
    try {
      await observerProfiles.prepare(configuration.runtimeObserverProfiles ?? [])
    } catch (error) {
      observerProfiles.close()
      throw error
    }
  },
  async prepareHostPlugins() {
    await plugins.prepareHostPlugins(configuration.runtimePlugins ?? [])
  },
  async initialize(planJson) {
    if (kernel != null) throw new Error('Native capability generation is already admitted')
    try {
      const plan = JSON.parse(planJson)
      const ownerId = 'desktop-host'
      const reference = bindingId => ({ bindingId, ownerId, version: '1' })
      const providers = createNativeProviders(native, projection)
      if (device != null) providers.set(device.provider.module, device.provider)
      if (network != null) providers.set(network.provider.module, network.provider)
      if (storage != null) providers.set(storage.provider.module, storage.provider)
      if (processRuntime != null) providers.set(processRuntime.provider.module, processRuntime.provider)
      const bindings = new Map([
        ['gate', Object.freeze({ kind: 'native-cordis-engine-gate' })],
        ['resolver', Object.freeze({ kind: 'native-module-plan' })],
        ['middleware', Object.freeze({ schemaVersion: 1, registrations: [] })],
        ...providers
      ])
      await observerProfiles.start()
      const profileBindings = observerProfiles.bind(ownerId)
      for (const [id, binding] of profileBindings.bindings) bindings.set(id, binding)
      observerProfiles.subscribe(profileBindings.bindings)
      admitted = admitRuntimeCreationV1({
        configuration: {
          schemaVersion: 1,
          context,
          ...(device == null ? {} : { deviceProviderDescriptor: device.descriptor }),
          inspector: { enabled: inspectorInstalled },
          sandboxPolicy: policy,
          systemProjection: projection,
          launch: {
            entryUrl: plan.entryUrl,
            moduleRootUrl: plan.rootUrl,
            moduleCount: plan.modules.length,
            totalSourceBytes: plan.modules.reduce(
              (total, module) => total + (module.source == null ? 0 : utf8ByteLength(module.source)),
              0
            ),
            moduleGraphDigest: canonicalDigest(plan.modules.map(module => [module.url, module.sha256]))
          }
        },
        hostBindings: {
          engineGate: reference('gate'),
          moduleResolver: reference('resolver'),
          initialMiddlewareSet: reference('middleware'),
          initialObservers: profileBindings.references,
          providerBindings: [...providers.keys()].map(module => ({
            module,
            ownerId,
            providerId: module,
            providerVersion: '1'
          }))
        }
      }, {
        expectedOwnerId: ownerId,
        generation: 1,
        processId: 'desktop-runtime',
        resolveBinding: ref => bindings.get(ref.bindingId)
      })
      kernel = new CapabilityRuntimeInvocationKernelV1({
        admitted,
        engine: 'embedded-v8',
        target: 'desktop',
        requestPrefix: 'desktop',
        networkProvider: policy.network.access === 'mockOnly' ? 'host.network.mock' : 'host.network',
        ...(requestBodyReaderSelection == null ? {} : { networkRequestBodyReader: requestBodyReaderSelection })
      })
      processRuntime?.bindKernel(kernel)
      subscriptions = createNativeResourceSubscriptions(
        kernel,
        providers,
        Math.max(1, policy.filesystem.limits?.maxQueuedEvents ?? 1)
      )
      await plugins.initialize(kernel, configuration.runtimePlugins ?? [])
    } catch (error) {
      observerProfiles.close()
      throw error
    }
  },
  invokeSync: json => kernel.invokeSync(json),
  async replacePlugins(encoded) {
    try {
      const snapshot = await plugins.replace(JSON.parse(encoded))
      return JSON.stringify({ ok: true, revision: snapshot.pluginGraphRevision })
    } catch {
      return JSON.stringify({ ok: false })
    }
  },
  invokeImmediate: json => kernel.invokeImmediate(json),
  async invoke(json, cancellationId, initiallyAborted, networkRequestBodyBase64) {
    const controller = cancellationId === '' ? undefined : new AbortController()
    if (initiallyAborted) controller?.abort()
    if (controller != null) cancellations.set(cancellationId, controller)
    try {
      return await kernel.invoke(
        json,
        controller?.signal,
        networkRequestBodyBase64 === undefined ? undefined : { networkRequestBodyBase64 }
      )
    } finally {
      cancellations.delete(cancellationId)
    }
  },
  abort: id => cancellations.get(id)?.abort(),
  release: id => kernel.releaseResource(id),
  subscribe: id => subscriptions.subscribe(id),
  unsubscribe: id => subscriptions.unsubscribe(id),
  drainResourceEvents: () => subscriptions?.drain() ?? JSON.stringify({ events: [], remaining: 0 }),
  gateEngineCode: (encoded, sourcePrefix) => gate.decide(encoded, sourcePrefix),
  cancelEngineGate: id => gate.cancel(id),
  observeEngineEvent: encoded => observers.publish(encoded),
  portCommand: json => nativePort?.command(json) ?? JSON.stringify({ events: [], remaining: 0 }),
  drainPortEvents: () => nativePort?.drain() ?? JSON.stringify({ events: [], remaining: 0 }),
  async close() {
    gate.close()
    engineGates.close()
    observerProfiles.close()
    observers.close()
    for (const controller of cancellations.values()) controller.abort()
    cancellations.clear()
    await plugins.close()
    subscriptions?.close()
    nativePort?.close()
    storage?.close()
    device?.close()
    await processRuntime?.close()
    kernel?.close()
  }
})
