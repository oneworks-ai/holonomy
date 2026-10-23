/* eslint-disable max-lines -- Android transport and atomic Runtime composition share one captured Host. */
import { createAndroidCryptoProvider } from './android-crypto-provider.mjs'
import { createAndroidCapabilityRuntime } from './capability-runtime.mjs'
import { RuntimeEventLoop } from './modules/event-loop/index.js'
import { createRuntimeConsole } from './modules/runtime-console/index.js'
import { createHolonomyRuntime } from './modules/runtime/index.js'
import { createRuntimeTimers } from './modules/timers/index.js'
import { NetworkMockRouter } from './modules/web-network/network-mock-router.js'
import { WebAbortController, WebAbortSignal } from './modules/web-network/web-abort.js'
import { RuntimeTextDecoder, RuntimeURL, RuntimeURLSearchParams } from './runtime-web-standards.mjs'

export const createAndroidRuntimeHost = (host, options = {}) => {
  const runtimeArchitecture = host.architecture()
  const processConfiguration = JSON.parse(host.processConfiguration())
  const cryptoEnabled = host.cryptoAvailable()
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
  const TypedArrayPrototype = Object.getPrototypeOf(UINT8_ARRAY.prototype)
  const typedLength = Object.getOwnPropertyDescriptor(TypedArrayPrototype, 'length').get
  const typedBuffer = Object.getOwnPropertyDescriptor(TypedArrayPrototype, 'buffer').get
  const setBytes = UINT8_ARRAY.prototype.set
  const setPrototypeOf = Object.setPrototypeOf
  const privateArray = () => setPrototypeOf([], null)
  const nativeBuffer = bytes => {
    const length = APPLY(typedLength, bytes, [])
    const copy = new UINT8_ARRAY(length)
    APPLY(setBytes, copy, [bytes])
    return APPLY(typedBuffer, copy, [])
  }
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
  const storageEnabled = nativeCapabilities.includes('host.storage.v1') && nativeConfiguration.storage != null
  globalThis.URL = RuntimeURL
  globalThis.URLSearchParams = RuntimeURLSearchParams
  globalThis.TextDecoder = RuntimeTextDecoder
  globalThis.AbortController = WebAbortController
  globalThis.AbortSignal = WebAbortSignal

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
    const tokens = privateArray()
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
    const provisional = privateArray()
    try {
      const event = JSON_PARSE(eventJson)
      if (event?.id !== record.requestId) throw new TypeError('Invalid native event request')
      if (!ARRAY_IS_ARRAY(handles) || !ARRAY_IS_ARRAY(values) || handles.length !== values.length) {
        throw new TypeError('Invalid native binary envelope')
      }
      const tokens = transportResources(callToken, record, event)
      for (let index = 0; index < tokens.length; index += 1) arrayPush(provisional, tokens[index])
      if (handles.length > 0) {
        const binary = privateArray()
        for (let index = 0; index < handles.length; index += 1) {
          arrayPush(binary, { data: new UINT8_ARRAY(values[index]), handle: handles[index] })
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
        const binaryHandles = privateArray()
        const binaryValues = privateArray()
        for (let index = 0; index < binary.length; index += 1) {
          arrayPush(binaryHandles, binary[index].handle)
          arrayPush(binaryValues, nativeBuffer(binary[index].data))
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
      bodySha256: body => host.sha256Hex(nativeBuffer(body)),
      bodySha256Chunks: body => {
        const buffers = privateArray()
        for (let index = 0; index < body.length; index += 1) arrayPush(buffers, nativeBuffer(body[index]))
        return host.sha256HexChunks(buffers)
      },
      delay: milliseconds =>
        new Promise(resolve => {
          eventLoop.setTimeout(resolve, milliseconds)
        }),
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
  const capabilityRuntime = createAndroidCapabilityRuntime(host, {
    eventLoop,
    process: nodeCore.process,
    processControl: nodeCore.processControl,
    stdio: nodeCore.stdio
  })

  globalThis.__oneworksAndroidTurn = () => {
    const result = eventLoop.runTurn()
    options.onTurn?.(result)
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
      if (
        !['linuxFilesystem', 'linuxCapability', 'linuxProcessExecution', 'linuxProcessNetwork'].includes(channel) ||
        capabilityRuntime == null
      ) {
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
        : channel === 'linuxCapability'
        ? await capabilityRuntime.linuxCapability.invoke(input)
        : channel === 'linuxProcessExecution'
        ? await capabilityRuntime.linuxProcessExecution.authorize(input)
        : await capabilityRuntime.linuxProcessNetwork.authorize(input)
      return JSON_STRINGIFY({ ok: true, result: trustedBackendValue(value) })
    } catch (error) {
      return JSON_STRINGIFY({
        error: {
          code: typeof error?.code === 'string' ? error.code : 'runtime.internal',
          ...(Number.isInteger(error?.errno) ? { errno: error.errno } : {}),
          message: typeof error?.message === 'string' ? error.message : 'Trusted Backend invocation failed',
          ...(typeof error?.operation === 'string' ? { operation: error.operation } : {})
        },
        ok: false
      })
    }
  }

  const runtimeReady = createHolonomyRuntime({
    authority: { capabilities: nativeCapabilities, principal: nativePrincipal },
    console: runtimeConsole,
    ...(cryptoEnabled
      ? {
        crypto: {
          provider: createAndroidCryptoProvider(host.cryptoCall.bind(host)),
          limits: JSON_PARSE(host.cryptoLimits())
        }
      }
      : {}),
    ...(storageEnabled
      ? {
        storage: {
          capabilities: nativeCapabilities,
          principal: nativePrincipal,
          namespace: nativeConfiguration.storage.namespace,
          operations: nativeConfiguration.storage.operations.map(operation => operation.slice(3)),
          limits: {
            maxKeyBytes: nativeConfiguration.storage.limits.maxKeyBytes,
            maxKeysPerList: nativeConfiguration.storage.limits.maxKeysPerList,
            maxValueBytes: nativeConfiguration.storage.limits.maxValueBytes
          }
        }
      }
      : {}),
    eventLoop,
    moduleLoader: options.moduleLoader ?? { readModule: () => null, rootUrl: 'app://runtime/' },
    nativePort: networkPort,
    ...(networkEnabled
      ? {
        network: {
          authority: nativeConfiguration.network,
          ...(capabilityRuntime == null ? {} : { capability: capabilityRuntime.network }),
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
    const runtime = createdRuntime
    host.installSyntheticModules(runtime.syntheticModules)
    for (const [name, value] of Object.entries(runtime.globals)) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        enumerable: false,
        value,
        writable: true
      })
    }
    options.onReady?.(runtime)
    return runtime
  }).catch(error => {
    options.onError?.(error)
    throw error
  })
  globalThis.__oneworksAndroidReady = () => runtimeReady

  return Object.freeze({
    capabilityRuntime,
    cryptoEnabled,
    eventLoop,
    nativeCapabilities,
    nativeConfiguration,
    networkEnabled,
    networkPort,
    ready: runtimeReady,
    runtimeArchitecture,
    timers
  })
}
