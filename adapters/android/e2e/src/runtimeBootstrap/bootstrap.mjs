/* eslint-disable max-lines -- E2E-only diagnostics remain outside production assets. */
import { createAndroidRuntimeHost } from './runtime-host.mjs'
import { RuntimeURL } from './runtime-web-standards.mjs'

const host = globalThis.__oneworksAndroidHost
if (host == null) throw new Error('Android host is unavailable')
delete globalThis.__oneworksAndroidHost
const arrayPush = (array, value) => array.push(value)
const runtimeArchitecture = host.architecture()
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

const readFixture = (canonicalUrl) => {
  const url = new RuntimeURL(canonicalUrl)
  if (url.protocol !== 'holonomy:' || url.host !== '' || !url.pathname.startsWith('/fixtures/')) return null
  const encoded = host.readAsset(`runtime${url.pathname}`)
  if (encoded == null) return null
  const asset = JSON.parse(encoded)
  return { bytes: asciiBytes(asset.source), sha256: asset.sha256 }
}

const publicError = error => ({
  code: typeof error?.code === 'string' ? error.code : null,
  domain: typeof error?.domain === 'string' ? error.domain : null,
  message: typeof error?.message === 'string' ? error.message : 'Runtime operation failed',
  name: typeof error?.name === 'string' ? error.name : 'Error'
})

let runtime
const composition = createAndroidRuntimeHost(host, {
  moduleLoader: { readModule: readFixture, rootUrl: 'holonomy:///fixtures/' },
  onTurn: result => {
    if (result.taskKind != null) state.turnKinds.push(result.taskKind)
  },
  onReady: created => {
    runtime = created
    state.phase = 'ready'
  },
  onError: error => {
    state.error = publicError(error)
    state.phase = 'failed'
  }
})
const { capabilityRuntime, cryptoEnabled, eventLoop, networkEnabled } = composition
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
  'node:timers',
  ...(cryptoEnabled ? ['node:crypto'] : [])
])
const EXPECTED_GLOBALS = Object.freeze([
  'ReadableStream',
  'TransformStream',
  'WritableStream',
  'WebSocket',
  'AbortController',
  'AbortSignal',
  ...(cryptoEnabled ? ['crypto'] : []),
  'console',
  'clearInterval',
  'clearTimeout',
  'setInterval',
  'setTimeout',
  'clearImmediate',
  'setImmediate',
  ...(networkEnabled
    ? ['Headers', 'Request', 'Response', 'fetch']
    : [])
])
const OPTIONAL_CAPABILITIES = Object.freeze([
  'child-process',
  ...(cryptoEnabled ? [] : ['crypto']),
  'fs',
  'git',
  'http-server',
  ...(networkEnabled ? [] : ['network']),
  'storage'
])

globalThis.__oneworksHolonomy = Object.freeze({
  dispose() {
    state.phase = 'disposing'
    eventLoop.setTimeout(() => {
      state.disposeRaceFired = true
    }, 500)
    capabilityRuntime?.close()
    runtime.dispose().then(async () => {
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
  exerciseNativeBinarySnapshot(input) {
    state.nativeBinary = { phase: 'pending' }
    runtime.bridge.request({
      args: {},
      ...(input == null ? {} : { binary: [{ handle: 'snapshot-input', data: input }] }),
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
