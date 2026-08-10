/* eslint-disable max-lines -- The generated E2E bootstrap keeps its composer state and controls together. */

import { RuntimeEventLoop } from './modules/event-loop/index.js'
import { createMobileRuntime } from './modules/runtime/index.js'
import { RuntimeTextDecoder, RuntimeURL, RuntimeURLSearchParams } from './runtime-web-standards.mjs'

const host = globalThis.__oneworksAndroidHost
if (host == null) throw new Error('Android host is unavailable')
delete globalThis.__oneworksAndroidHost
const runtimeArchitecture = host.architecture()
globalThis.URL = RuntimeURL
globalThis.URLSearchParams = RuntimeURLSearchParams
globalThis.TextDecoder = RuntimeTextDecoder

const EXPECTED_MODULES = Object.freeze([
  'node:buffer',
  'node:events',
  'node:os',
  'node:path',
  'node:process',
  'node:url',
  'node:stream',
  'node:stream/promises',
  'node:stream/web'
])
const EXPECTED_GLOBALS = Object.freeze(['ReadableStream', 'TransformStream', 'WritableStream'])
const OPTIONAL_CAPABILITIES = Object.freeze([
  'child-process',
  'crypto',
  'fs',
  'git',
  'http-server',
  'network',
  'storage'
])

const state = {
  architecture: runtimeArchitecture,
  disposeRaceFired: false,
  error: null,
  eventOrder: [],
  native: null,
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

const failClosedPort = {
  cancel() {},
  closeResource() {},
  dispatch(request, context, sink) {
    let terminal
    try {
      terminal = JSON.parse(host.dispatch(
        JSON.stringify(request),
        JSON.stringify({ authority: context.authority, mode: context.mode })
      ))
    } catch (_) {
      terminal = { error: { code: 'internal', domain: 'runtime' }, type: 'error' }
    }
    if (terminal?.type !== 'result' && terminal?.type !== 'error') {
      terminal = { error: { code: 'protocol_error', domain: 'runtime' }, type: 'error' }
    }
    sink({ ...terminal, id: request.id })
  },
  dispose() {},
  grantCredits() {}
}

const readFixture = (canonicalUrl) => {
  const url = new RuntimeURL(canonicalUrl)
  if (url.protocol !== 'app:' || url.host !== '' || !url.pathname.startsWith('/fixtures/')) return null
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
    argv: [],
    cwd: '/runtime',
    env: {},
    execPath: '/runtime/node',
    pid: 1,
    platform: 'android',
    versions: { node: '22' }
  },
  stdio: { write: () => true },
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

let runtime
createMobileRuntime({
  authority: { capabilities: [], principal: 'android-m2-e2e' },
  eventLoop,
  moduleLoader: { readModule: readFixture, rootUrl: 'app:///fixtures/' },
  nativePort: failClosedPort,
  nodeCore
}).then(createdRuntime => {
  runtime = createdRuntime
  state.phase = 'ready'
}).catch(error => {
  state.error = publicError(error)
  state.phase = 'failed'
})

globalThis.__oneworksAndroidM2 = Object.freeze({
  dispose() {
    state.phase = 'disposing'
    eventLoop.setTimeout(() => {
      state.disposeRaceFired = true
      host.dispatch('{"id":"dispose-race"}', '{}')
    }, 500)
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
      nativeBridge: snapshot.nativeBridge,
      optionalCapabilities: OPTIONAL_CAPABILITIES,
      phase: state.phase,
      plan: state.plan,
      turnKinds: state.turnKinds,
      wakeupOrder: state.wakeupOrder
    }
  }
})
