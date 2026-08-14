/* eslint-disable max-lines -- The generated E2E bootstrap keeps its composer state and controls together. */

import { runtimePluginNamespaces } from 'holo-plugins:///manifest.mjs'
import { createAndroidCapabilityRuntime } from './capability-runtime.mjs'
import { RuntimeEventLoop } from './modules/event-loop/index.js'
import { createRuntimeConsole } from './modules/runtime-console/index.js'
import { createHolonomyRuntime } from './modules/runtime/index.js'
import { HolonomyRuntimePluginAppV1 } from './modules/runtime/plugin-app.js'
import { createRuntimeTimers } from './modules/timers/index.js'
import { NetworkMockRouter } from './modules/web-network/network-mock-router.js'
import { WebAbortController, WebAbortSignal } from './modules/web-network/web-abort.js'
import { RuntimeTextDecoder, RuntimeURL, RuntimeURLSearchParams } from './runtime-web-standards.mjs'

const host = globalThis.__oneworksAndroidHost
if (host == null) throw new Error('Android host is unavailable')
delete globalThis.__oneworksAndroidHost
const runtimeArchitecture = host.architecture()
const processConfiguration = JSON.parse(host.processConfiguration())
const runtimePluginBundles = JSON.parse(host.runtimePlugins())
const runtimePluginDefinitions = runtimePluginBundles.map(bundle => ({
  bundleSha256: bundle.bundleSha256,
  config: bundle.config,
  entryUrl: bundle.entryUrl,
  exportName: bundle.exportName,
  instanceId: bundle.instanceId
}))
const nativeConfiguration = (() => {
  try {
    const value = JSON.parse(host.nativeConfiguration())
    return value != null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
})()
const APPLY = Reflect.apply
const ARRAY_IS_ARRAY = Array.isArray
const JSON_PARSE = JSON.parse
const JSON_STRINGIFY = JSON.stringify
const ARRAY_PUSH = Array.prototype.push
const MAP_CLEAR = Map.prototype.clear
const MAP_DELETE = Map.prototype.delete
const MAP_GET = Map.prototype.get
const MAP_SET = Map.prototype.set
const SET_ADD = Set.prototype.add
const SET_DELETE = Set.prototype.delete
const SET_HAS = Set.prototype.has
const SET_SIZE = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get
const UINT8_ARRAY = Uint8Array
const mapDelete = (map, key) => APPLY(MAP_DELETE, map, [key])
const mapGet = (map, key) => APPLY(MAP_GET, map, [key])
const mapSet = (map, key, value) => APPLY(MAP_SET, map, [key, value])
const mapClear = map => APPLY(MAP_CLEAR, map, [])
const arrayPush = (array, value) => APPLY(ARRAY_PUSH, array, [value])
const setAdd = (set, value) => APPLY(SET_ADD, set, [value])
const setDelete = (set, value) => APPLY(SET_DELETE, set, [value])
const setHas = (set, value) => APPLY(SET_HAS, set, [value])
const setSize = set => APPLY(SET_SIZE, set, [])
const nativeCapabilities = Array.isArray(nativeConfiguration.capabilities)
  ? nativeConfiguration.capabilities.filter(value => typeof value === 'string')
  : []
const nativePrincipal = typeof nativeConfiguration.principal === 'string'
  ? nativeConfiguration.principal
  : 'android-runtime'
const networkEnabled = (nativeCapabilities.includes('host.network.http') ||
  nativeCapabilities.includes('host.network.mock')) &&
  nativeConfiguration.network != null && typeof nativeConfiguration.network === 'object'
globalThis.URL = RuntimeURL
globalThis.URLSearchParams = RuntimeURLSearchParams
globalThis.TextDecoder = RuntimeTextDecoder
globalThis.AbortController = WebAbortController
globalThis.AbortSignal = WebAbortSignal

const EXPECTED_MODULES = Object.freeze([
  'node:buffer',
  'node:events',
  'node:os',
  'node:path',
  'node:process',
  'node:url',
  'node:stream',
  'node:stream/promises',
  'node:stream/web',
  'node:assert/strict',
  'node:test',
  'node:console',
  'node:timers'
])
const EXPECTED_GLOBALS = Object.freeze([
  'ReadableStream',
  'TransformStream',
  'WritableStream',
  'AbortController',
  'AbortSignal',
  'console',
  'clearInterval',
  'clearTimeout',
  'setInterval',
  'setTimeout',
  ...(networkEnabled
    ? ['Headers', 'Request', 'Response', 'fetch']
    : [])
])
const OPTIONAL_CAPABILITIES = Object.freeze([
  'child-process',
  'crypto',
  'fs',
  'git',
  'http-server',
  ...(networkEnabled ? [] : ['network']),
  'storage'
])

const capabilityRuntime = createAndroidCapabilityRuntime(host)
const runtimePluginApp = new HolonomyRuntimePluginAppV1({
  importModule: async url => {
    const namespace = runtimePluginNamespaces[url]
    if (namespace == null) throw new Error('Android Runtime plugin namespace is unavailable')
    return namespace
  }
})

const state = {
  architecture: runtimeArchitecture,
  disposeRaceFired: false,
  error: null,
  eventOrder: [],
  native: null,
  nativeBinary: null,
  nativeResource: null,
  phase: 'starting',
  plan: null,
  turnKinds: [],
  wakeupOrder: []
}

const asciiBytes = (source) => {
  const output = new Uint8Array(source.length)
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    if (code > 0x7F) throw new TypeError('M2 fixtures must remain ASCII')
    output[index] = code
  }
  return output
}

const eventLoop = new RuntimeEventLoop({
  checkpointMicrotasks: () => host.checkpointMicrotasks(),
  now: () => host.now(),
  requestWakeup: deadlineMs => host.requestWakeup(deadlineMs),
  terminate: reason => host.terminate(JSON.stringify(reason))
})

const timers = createRuntimeTimers({
  cancel: timerId => host.cancelTimer(timerId),
  schedule: (delayMs, intervalMs) => host.scheduleTimer(delayMs, intervalMs)
})
const runtimeConsole = createRuntimeConsole({
  write: (level, message) =>
    host.writeOutput(
      level === 'error' || level === 'warn' ? 'stderr' : 'stdout',
      `[${level}] ${message}\n`
    )
})

const MAX_NATIVE_RESOURCES = 64
const nativeCalls = new Map()
const nativeProviderOwners = new Map()

const stableNativeError = id => ({
  error: { code: 'internal', domain: 'runtime' },
  id,
  type: 'error'
})

const transportResources = (callToken, record, event) => {
  if (event.resources === undefined) return []
  if (!ARRAY_IS_ARRAY(event.resources) || event.resources.length > MAX_NATIVE_RESOURCES) {
    throw new TypeError('Invalid native resource grants')
  }
  const tokens = []
  const seen = new Set()
  for (let index = 0; index < event.resources.length; index += 1) {
    const grant = event.resources[index]
    if (
      grant == null || typeof grant !== 'object' || ARRAY_IS_ARRAY(grant) ||
      typeof grant.providerToken !== 'string' || typeof grant.type !== 'string'
    ) throw new TypeError('Invalid native resource grant')
    const existing = mapGet(nativeProviderOwners, grant.providerToken)
    if (existing != null || setHas(seen, grant.providerToken) || setSize(seen) >= MAX_NATIVE_RESOURCES) {
      throw new TypeError('Native provider token collision')
    }
    setAdd(seen, grant.providerToken)
    arrayPush(tokens, grant.providerToken)
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const providerToken = tokens[index]
    const owner = { callToken, record }
    mapSet(nativeProviderOwners, providerToken, owner)
    setAdd(record.resources, providerToken)
  }
  return tokens
}

const releaseTransportToken = (ownerCallToken, providerToken) => {
  const owner = mapGet(nativeProviderOwners, providerToken)
  if (owner == null || owner.callToken !== ownerCallToken) return
  mapDelete(nativeProviderOwners, providerToken)
  setDelete(owner.record.resources, providerToken)
}

const rejectNativeEvent = (callToken, record, tokens) => {
  mapDelete(nativeCalls, callToken)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    releaseTransportToken(callToken, token)
    try {
      host.nativeCloseResource(callToken, token, 'invalid_native_event')
    } catch {}
  }
  try {
    host.nativeCancel(callToken, 'invalid_native_event')
  } catch {}
  try {
    record.sink(stableNativeError(record.requestId))
  } catch {
    host.terminate(JSON_STRINGIFY({ code: 'runtime.internal' }))
  }
}

const failNativeTransport = () => {
  mapClear(nativeCalls)
  mapClear(nativeProviderOwners)
  try {
    host.nativeDispose()
  } catch {}
  try {
    host.terminate(JSON_STRINGIFY({ code: 'runtime.internal' }))
  } catch {}
}

const completeNativeCall = (callToken, event) => {
  if (event.type === 'result' || event.type === 'error' || event.type === 'end') {
    mapDelete(nativeCalls, callToken)
  }
}

const deliverNativeResourceEvent = (callToken, eventJson) => {
  let event
  try {
    event = JSON_PARSE(eventJson)
    if (
      event == null || typeof event !== 'object' || ARRAY_IS_ARRAY(event) ||
      event.type !== 'revoke' || typeof event.providerToken !== 'string'
    ) throw new TypeError('Invalid native resource event')
  } catch {
    failNativeTransport()
    return
  }
  const owner = mapGet(nativeProviderOwners, event.providerToken)
  if (owner == null || owner.callToken !== callToken) return
  releaseTransportToken(callToken, event.providerToken)
  try {
    owner.record.resourceSink(event)
  } catch {
    failNativeTransport()
  }
}

const deliverNativeCallEvent = (callToken, eventJson, handles, values) => {
  const record = mapGet(nativeCalls, callToken)
  if (record == null) return
  const provisional = []
  try {
    const event = JSON_PARSE(eventJson)
    if (event?.id !== record.requestId) throw new TypeError('Invalid native event request')
    if (!ARRAY_IS_ARRAY(handles) || !ARRAY_IS_ARRAY(values) || handles.length !== values.length) {
      throw new TypeError('Invalid native binary envelope')
    }
    const tokens = transportResources(callToken, record, event)
    for (let index = 0; index < tokens.length; index += 1) arrayPush(provisional, tokens[index])
    if (handles.length > 0) {
      const binary = []
      for (let index = 0; index < handles.length; index += 1) {
        arrayPush(binary, { data: values[index], handle: handles[index] })
      }
      event.binary = binary
    }
    completeNativeCall(callToken, event)
    record.sink(event)
  } catch {
    rejectNativeEvent(callToken, record, provisional)
  }
}

globalThis.__oneworksAndroidNative = (callToken, channel, eventJson, handles, values) => {
  if (channel === 'transport-failure') failNativeTransport()
  else if (channel === 'resource') deliverNativeResourceEvent(callToken, eventJson)
  else deliverNativeCallEvent(callToken, eventJson, handles, values)
}

const nativePort = {
  cancel(callToken, reason) {
    mapDelete(nativeCalls, callToken)
    host.nativeCancel(callToken, reason ?? null)
  },
  closeResource(ownerCallToken, providerToken, reason) {
    releaseTransportToken(ownerCallToken, providerToken)
    host.nativeCloseResource(ownerCallToken, providerToken, reason ?? null)
  },
  dispatch(request, context, sink, resourceSink) {
    const callToken = context.callToken
    const record = { requestId: request.id, resourceSink, resources: new Set(), sink }
    mapSet(nativeCalls, callToken, record)
    const binary = request.binary ?? []
    const requestMetadata = { ...request }
    delete requestMetadata.binary
    try {
      const binaryHandles = []
      const binaryValues = []
      for (let index = 0; index < binary.length; index += 1) {
        arrayPush(binaryHandles, binary[index].handle)
        arrayPush(binaryValues, binary[index].data)
      }
      host.nativeDispatch(
        callToken,
        request.id,
        JSON_STRINGIFY(requestMetadata),
        JSON_STRINGIFY(context),
        binaryHandles,
        binaryValues
      )
    } catch {
      mapDelete(nativeCalls, callToken)
      sink(stableNativeError(request.id))
    }
  },
  dispose() {
    mapClear(nativeCalls)
    mapClear(nativeProviderOwners)
    host.nativeDispose()
  },
  grantCredits(callToken, credits) {
    host.nativeGrantCredits(callToken, credits)
  }
}

const networkPort = networkEnabled
  ? new NetworkMockRouter({
    authority: nativeConfiguration.network,
    bodySha256: body => host.sha256Hex(body),
    bodySha256Chunks: body => host.sha256HexChunks(body),
    passthrough: nativePort
  })
  : nativePort

globalThis.__oneworksHolonomyControl = (operation, valueJson) => {
  if (operation !== 'network.rules.replace' || !networkEnabled) {
    throw new TypeError('Unsupported runtime control operation')
  }
  const value = JSON_PARSE(valueJson)
  if (value == null || typeof value !== 'object' || ARRAY_IS_ARRAY(value)) {
    throw new TypeError('Invalid runtime control value')
  }
  if ('rules' in value && ('expectedRevision' in value || !('mode' in value))) {
    networkPort.rules.replace(value.rules, value.expectedRevision)
  } else {
    networkPort.rules.replace(value)
  }
}

const readFixture = (canonicalUrl) => {
  const url = new RuntimeURL(canonicalUrl)
  if (url.protocol !== 'holonomy:' || url.host !== '' || !url.pathname.startsWith('/fixtures/')) return null
  const encoded = host.readAsset(`runtime${url.pathname}`)
  if (encoded == null) return null
  const asset = JSON.parse(encoded)
  return { bytes: asciiBytes(asset.source), sha256: asset.sha256 }
}

const nodeCore = {
  appBaseUrl: 'app://runtime/',
  os: {
    arch: runtimeArchitecture,
    homedir: '/runtime/home',
    hostname: 'runtime',
    identityPolicy: 'synthetic',
    platform: 'android',
    release: '35',
    tmpdir: '/runtime/tmp',
    type: 'Mobile',
    userInfo: { gid: 1, homedir: '/runtime/home', shell: null, uid: 1, username: 'runtime' }
  },
  process: {
    arch: runtimeArchitecture,
    argv: processConfiguration.argv,
    cwd: processConfiguration.cwd,
    env: processConfiguration.env,
    execPath: processConfiguration.execPath,
    pid: processConfiguration.pid,
    platform: 'android',
    versions: { node: '22' }
  },
  processControl: { exit: code => host.exit(code) },
  stdio: {
    write: (stream, chunk) =>
      host.writeOutput(
        stream,
        typeof chunk === 'string' ? chunk : Array.from(chunk, byte => String.fromCharCode(byte)).join('')
      )
  },
  virtualRoot: '/runtime',
  webStandards: { URL: RuntimeURL, URLSearchParams: RuntimeURLSearchParams }
}

const publicError = error => ({
  code: typeof error?.code === 'string' ? error.code : null,
  domain: typeof error?.domain === 'string' ? error.domain : null,
  message: typeof error?.message === 'string' ? error.message : 'Runtime operation failed',
  name: typeof error?.name === 'string' ? error.name : 'Error'
})

globalThis.__oneworksAndroidTurn = () => {
  const result = eventLoop.runTurn()
  if (result.taskKind != null) state.turnKinds.push(result.taskKind)
}
globalThis.__oneworksAndroidTimer = timerId => timers.fire(timerId)

const trustedBackendValue = value => {
  if (!(value instanceof UINT8_ARRAY)) return { kind: 'value', value }
  const bytes = []
  for (let index = 0; index < value.length; index += 1) arrayPush(bytes, value[index])
  return { bytes, kind: 'bytes' }
}

globalThis.__oneworksAndroidTrustedBackend = async (channel, requestJson) => {
  try {
    if (!['linuxFilesystem', 'linuxProcessNetwork'].includes(channel) || capabilityRuntime == null) {
      throw Object.assign(new Error('Trusted Backend channel is unavailable'), {
        code: 'runtime.capability_unsupported'
      })
    }
    const input = JSON_PARSE(requestJson)
    if (channel === 'linuxFilesystem' && Array.isArray(input.bytes)) {
      if (
        input.bytes.length > 64 * 1024 ||
        input.bytes.some(value => !Number.isInteger(value) || value < 0 || value > 255)
      ) throw Object.assign(new Error('Invalid trusted Backend binary payload'), { code: 'argument.invalid' })
      input.bytes = new UINT8_ARRAY(input.bytes)
    }
    const value = channel === 'linuxFilesystem'
      ? await capabilityRuntime.linuxFilesystem.dispatch(input)
      : await capabilityRuntime.linuxProcessNetwork.authorize(input)
    return JSON_STRINGIFY({ ok: true, result: trustedBackendValue(value) })
  } catch (error) {
    return JSON_STRINGIFY({
      error: {
        code: typeof error?.code === 'string' ? error.code : 'runtime.internal',
        ...(Number.isInteger(error?.errno) ? { errno: error.errno } : {}),
        message: typeof error?.message === 'string' ? error.message : 'Trusted Backend invocation failed'
      },
      ok: false
    })
  }
}

let runtime
const runtimeReady = createHolonomyRuntime({
  authority: { capabilities: nativeCapabilities, principal: nativePrincipal },
  console: runtimeConsole,
  eventLoop,
  moduleLoader: { readModule: readFixture, rootUrl: 'holonomy:///fixtures/' },
  nativePort: networkPort,
  ...(networkEnabled
    ? {
      network: {
        authority: nativeConfiguration.network,
        diagnostics: { emit: event => host.networkDiagnostic(JSON_STRINGIFY(event)) },
        diagnosticsBodyLimitBytes: 2 * 1024 * 1024,
        diagnosticsNow: () => host.now(),
        principal: nativePrincipal
      }
    }
    : {}),
  nodeCore,
  ...(capabilityRuntime == null ? {} : { moduleOverrides: capabilityRuntime.moduleOverrides }),
  testPlatform: 'android',
  timers
}).then(async createdRuntime => {
  runtime = createdRuntime
  host.installSyntheticModules(runtime.syntheticModules)
  for (const [name, value] of Object.entries(runtime.globals)) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: false,
      value: name === 'fetch' && capabilityRuntime != null ? capabilityRuntime.fetch(value) : value,
      writable: true
    })
  }
  await runtimePluginApp.replace(runtimePluginDefinitions)
  state.phase = 'ready'
}).catch(error => {
  state.error = publicError(error)
  state.phase = 'failed'
  throw error
})
globalThis.__oneworksAndroidReady = () => runtimeReady

globalThis.__oneworksHolonomy = Object.freeze({
  dispose() {
    state.phase = 'disposing'
    eventLoop.setTimeout(() => {
      state.disposeRaceFired = true
    }, 500)
    capabilityRuntime?.close()
    runtimePluginApp.close().then(() => runtime.dispose()).then(async () => {
      let loaderError = null
      try {
        await runtime.moduleLoader.createPlan('./managed-plugin.mjs')
      } catch (error) {
        loaderError = publicError(error)
      }
      state.phase = 'disposed'
      state.loaderAfterDispose = loaderError
    }).catch(error => {
      state.error = publicError(error)
      state.phase = 'failed'
    })
  },
  exerciseEventLoop() {
    state.eventOrder = []
    state.turnKinds = []
    eventLoop.enqueueMacrotask(() => {
      state.eventOrder.push('macrotask')
      Promise.resolve().then(() => {
        state.eventOrder.push('promise')
      })
      eventLoop.setTimeout(() => {
        state.eventOrder.push('timer')
      }, 25)
    })
  },
  exerciseFatalTermination() {
    eventLoop.enqueueMacrotask(() => {
      throw new Error('must-not-cross-fatal-boundary')
    })
  },
  exerciseWakeupRearm() {
    state.wakeupOrder = []
    const cancelled = eventLoop.setTimeout(() => {
      state.wakeupOrder.push('cancelled')
    }, 10)
    eventLoop.setTimeout(() => {
      state.wakeupOrder.push('early')
    }, 35)
    eventLoop.setTimeout(() => {
      state.wakeupOrder.push('late')
    }, 90)
    eventLoop.clearTimer(cancelled)
  },
  exerciseNativeCompletion() {
    state.native = { phase: 'pending' }
    runtime.bridge.request({
      args: { secret: 'must-not-cross-error-boundary' },
      id: 'android-m2-native',
      module: 'host.unsupported',
      operation: 'probe'
    }).then(() => {
      state.native = { phase: 'unexpected-success' }
    }).catch(error => {
      state.native = { error: publicError(error), phase: 'rejected' }
    })
    return { beforeTurn: runtime.getSnapshot().nativeBridge.pendingRequests }
  },
  async exerciseLinuxFilesystemBridge() {
    if (capabilityRuntime == null) throw new Error('Capability Runtime is unavailable')
    const policy = Object.freeze({
      access: 'sandboxed',
      environment: Object.freeze({ allowedNames: Object.freeze([]), maxValueBytes: 1 }),
      executables: Object.freeze([]),
      limits: Object.freeze({
        maxConcurrentProcesses: 1,
        maxExecutionTimeMs: 1_000,
        maxOpenPipes: 3,
        maxProcessTreeDepth: 1,
        maxStderrBytes: 4_096,
        maxStdinBytes: 4_096,
        maxStdoutBytes: 4_096,
        maxTotalProcesses: 1,
        maxWritableRootfsBytes: 4_096
      }),
      mounts: Object.freeze([Object.freeze({
        guestPath: '/workspace',
        rights: Object.freeze(['read', 'write']),
        rootId: 'workspace'
      })]),
      network: Object.freeze({ access: 'none' }),
      shell: Object.freeze({ access: 'none' })
    })
    const common = Object.freeze({
      environmentId: 'android-v86-environment',
      executableId: 'android-v86-fuse',
      linuxPid: 41,
      policy,
      processId: 9,
      processResourceId: 'android-v86-fuse-process',
      scope: 'runtime'
    })
    const dispatch = input => capabilityRuntime.linuxFilesystem.dispatch({ ...common, ...input })
    const metadata = await dispatch({ operation: 'lookup', path: '/workspace/input.txt' })
    const inputHandle = await dispatch({ flags: 0, operation: 'open', path: '/workspace/input.txt' })
    const input = await dispatch({
      handle: inputHandle,
      offset: 0,
      operation: 'read',
      path: '/workspace/input.txt',
      size: 64
    })
    await dispatch({ handle: inputHandle, operation: 'release', path: '/workspace/input.txt' })
    const outputHandle = await dispatch({
      flags: 0x41,
      operation: 'create',
      path: '/workspace/linux-output.txt'
    })
    const outputBytes = asciiBytes('android-linux-output')
    const written = await dispatch({
      bytes: outputBytes,
      handle: outputHandle.handle,
      offset: 0,
      operation: 'write',
      path: '/workspace/linux-output.txt'
    })
    await dispatch({
      handle: outputHandle.handle,
      operation: 'release',
      path: '/workspace/linux-output.txt'
    })
    return Object.freeze({
      input: new TextDecoder().decode(input),
      linuxPid: common.linuxPid,
      size: metadata.size,
      syntheticProcessId: common.processId,
      written
    })
  },
  exerciseNativeBinarySnapshot() {
    state.nativeBinary = { phase: 'pending' }
    runtime.bridge.request({
      args: {},
      id: 'android-native-binary',
      module: 'host.snapshot',
      operation: 'probe'
    }).then(result => {
      const data = result.binary?.[0]?.data
      const bytes = []
      if (data != null) {
        for (let index = 0; index < data.byteLength; index += 1) arrayPush(bytes, data[index])
      }
      state.nativeBinary = { bytes, phase: 'resolved' }
    }).catch(error => {
      state.nativeBinary = { error: publicError(error), phase: 'rejected' }
    })
  },
  exerciseNativeResourceTransport() {
    state.nativeResource = { phase: 'pending' }
    runtime.bridge.request({
      args: {},
      id: 'android-native-resource',
      module: 'host.snapshot',
      operation: 'resource'
    }).then(result => {
      state.nativeResource = {
        phase: 'resolved',
        type: result.resources?.[0]?.type ?? null
      }
    }).catch(error => {
      state.nativeResource = { error: publicError(error), phase: 'rejected' }
    })
  },
  exercisePlan() {
    state.plan = { phase: 'planning' }
    runtime.moduleLoader.createPlan('./managed-plugin.mjs').then(plan => {
      state.plan = {
        entryUrl: plan.entryUrl,
        modules: plan.modules.map(module => ({
          dependencies: module.dependencies,
          format: module.format,
          url: module.url
        })),
        phase: 'planned'
      }
    }).catch(error => {
      state.plan = { error: publicError(error), phase: 'failed' }
    })
  },
  inspect() {
    if (runtime == null) return { error: state.error, phase: state.phase }
    const snapshot = runtime.getSnapshot()
    const capabilityStatus = Object.fromEntries(
      Object.entries(runtime.capabilities).map(([name, value]) => [name, value.status])
    )
    return {
      architecture: state.architecture,
      capabilityStatus,
      disposeRaceFired: state.disposeRaceFired,
      error: state.error,
      eventOrder: state.eventOrder,
      expectedGlobals: EXPECTED_GLOBALS,
      expectedModules: EXPECTED_MODULES,
      globals: snapshot.globals,
      loaderAfterDispose: state.loaderAfterDispose ?? null,
      modules: snapshot.modules,
      native: state.native,
      nativeBinary: state.nativeBinary,
      nativeResource: state.nativeResource,
      nativeBridge: snapshot.nativeBridge,
      optionalCapabilities: OPTIONAL_CAPABILITIES,
      phase: state.phase,
      plan: state.plan,
      turnKinds: state.turnKinds,
      wakeupOrder: state.wakeupOrder
    }
  }
})
