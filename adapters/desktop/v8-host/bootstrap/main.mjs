import { createCapabilityProcessOverrideV1 } from '../../../../packages/capabilities/process/src/kernel/guest-process-facade.ts'
import { createHolonomyRuntime } from '../../../../packages/runtime/src/app/index.ts'
import { RuntimeEventLoop } from '../../../../packages/runtime/src/event-loop/index.ts'
import {
  createCapabilityCallbackDispatcherV1,
  createCapabilityModuleOverridesV1,
  createCapabilityNetworkHooksV1
} from '../../../../packages/runtime/src/kernel/guest-facades.ts'
import {
  createCommonJsModuleStateV1,
  createCommonJsRequireV1
} from '../../../../packages/runtime/src/module-loader/commonjs-runtime.ts'
import { createRuntimeConsole } from '../../../../packages/runtime/src/runtime-console/index.ts'
import { createRuntimeTimers } from '../../../../packages/runtime/src/timers/index.ts'
import { RuntimeTextDecoder, RuntimeURL, RuntimeURLSearchParams } from '../../../node/src/runtime-web-standards.mjs'

import { createNativeCapabilityBridge } from './capability-bridge.mjs'
import { createNativeCryptoProvider } from './crypto-provider.mjs'
import { createNativeGuestPort } from './native-port-guest.mjs'
import { installNativeWasm } from './wasm.mjs'

const host = globalThis.__holoNativeHost
delete globalThis.__holoNativeHost
const parseJson = JSON.parse
const stringifyJson = JSON.stringify
const configuration = parseJson(host.configuration())
installNativeWasm(host)
globalThis.URL = RuntimeURL
globalThis.URLSearchParams = RuntimeURLSearchParams
globalThis.TextDecoder = RuntimeTextDecoder

// JS retains timer callbacks, ordering, cancellation and interval semantics.
// Rust provides only monotonic time, wakeups and the microtask checkpoint.
const loop = new RuntimeEventLoop({
  checkpointMicrotasks() {},
  now: () => host.now(),
  requestWakeup: deadline => host.wakeup(deadline),
  terminate: reason => {
    if (reason.kind === 'error') {
      host.output('stderr', `${host.callbackDiagnostic(reason)}\n`)
      host.exit(1)
    } else {
      host.exit(0)
    }
  }
})
const timers = createRuntimeTimers({
  cancel: id => loop.clearTimer(id),
  schedule: (delay, interval) => {
    const id = loop.setTimer(
      () => timers.fire(id),
      delay,
      interval === undefined ? {} : { intervalMs: Math.max(1, interval) }
    )
    return id
  }
})

export const ready = (async () => {
  const capability = configuration.capabilityEnabled ? parseJson(host.capabilityConfiguration()) : null
  const processSnapshot = {
    arch: configuration.arch,
    argv: configuration.argv,
    cwd: '/runtime',
    env: {},
    execPath: '/runtime/holo',
    pid: 1,
    platform: configuration.platform,
    versions: { holonomy: configuration.version, v8: configuration.v8 }
  }
  const processControl = {
    exit: code => host.exit(code),
    nextTick: (callback, ...args) => {
      loop.enqueueNextTick(() => callback(...args))
    }
  }
  const stdio = { write: (stream, chunk) => host.output(stream, chunk) }
  const bridge = createNativeCapabilityBridge(host, createCapabilityCallbackDispatcherV1(loop))
  const runtime = await createHolonomyRuntime({
    ...(capability == null
      ? {}
      : { moduleOverrides: createCapabilityModuleOverridesV1({ ...capability, processControl }, bridge) }),
    authority: { capabilities: capability?.capabilities ?? [], principal: 'desktop-runtime' },
    ...(capability?.network == null
      ? {}
      : {
        network: {
          authority: capability.network,
          principal: 'desktop-runtime',
          capability: createCapabilityNetworkHooksV1(bridge, {
            requestBodyReaderMaxBytes: capability.networkRequestBodyReaderMaxBytes
          })
        }
      }),
    console: createRuntimeConsole({ write: (level, message) => host.output(level, message) }),
    crypto: { provider: createNativeCryptoProvider(host.crypto) },
    eventLoop: loop,
    nativePort: capability?.network == null &&
        capability?.storage == null
      ? {
        cancel() {},
        closeResource() {},
        dispose() {},
        grantCredits() {},
        dispatch(_request, _context, sink) {
          sink({ error: { domain: 'runtime', code: 'permission_denied' }, type: 'error' })
        }
      }
      : createNativeGuestPort(host),
    ...(capability?.storage == null ? {} : {
      storage: {
        capabilities: capability.capabilities,
        limits: capability.storage.limits,
        namespace: 'default',
        operations: capability.storage.operations,
        principal: 'desktop-runtime'
      }
    }),
    nodeCore: {
      appBaseUrl: 'app://workspace/',
      os: {
        arch: configuration.arch,
        homedir: '/runtime/home',
        hostname: 'runtime',
        identityPolicy: 'synthetic',
        platform: configuration.platform,
        release: 'Holonomy',
        tmpdir: '/runtime/tmp',
        type: 'Holonomy',
        userInfo: { gid: 1, homedir: '/runtime/home', shell: null, uid: 1, username: 'runtime' }
      },
      process: processSnapshot,
      processControl,
      stdio,
      virtualRoot: '/runtime',
      webStandards: { URL: RuntimeURL, URLSearchParams: RuntimeURLSearchParams }
    },
    testPlatform: 'desktop',
    testPromiseBrand: value => host.isPromise(value),
    timers
  })
  for (const [name, value] of Object.entries(runtime.globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, value, writable: true })
  }
  // Install the same process and Buffer namespaces used by explicit node imports.
  let modules = runtime.syntheticModules
  let runtimeProcess = modules['node:process'].namespace.default
  let capabilitiesInitialized = false
  Object.defineProperty(globalThis, 'process', { value: runtimeProcess, writable: true, configurable: true })
  Object.defineProperty(globalThis, 'Buffer', {
    value: runtime.syntheticModules['node:buffer'].namespace.Buffer,
    writable: true,
    configurable: true
  })
  return Object.freeze({
    createCommonJsModule: createCommonJsModuleStateV1,
    createCommonJsRequire: createCommonJsRequireV1,
    initializeCapabilities() {
      if (capabilitiesInitialized) throw new Error('Guest capabilities are already initialized')
      capabilitiesInitialized = true
      if (capability == null) return
      const binding = createCapabilityProcessOverrideV1({
        ...capability,
        process: processSnapshot,
        processControl,
        stdio
      }, bridge)
      const expected = [...modules['node:process'].descriptor.exportNames].sort()
      const actual = [...binding.descriptor.exportNames].sort()
      if (stringifyJson(expected) !== stringifyJson(actual)) {
        throw new Error('Admitted process exports differ from the planned module')
      }
      modules = Object.freeze({ ...modules, 'node:process': binding })
      runtimeProcess = binding.namespace.default
      Object.defineProperty(globalThis, 'process', { value: runtimeProcess, writable: true, configurable: true })
    },
    complete: async () => {
      if (!configuration.testMode) return
      const report = await runtime.syntheticModules['node:test'].namespace.run()
      host.output('info', stringifyJson(report))
      runtimeProcess.exitCode = report.failed > 0 ? 1 : 0
    },
    dispose: () => runtime.dispose(),
    exitCode: () => runtimeProcess.exitCode,
    get modules() {
      return modules
    },
    moduleDefinitions: stringifyJson(Object.fromEntries(
      Object.entries(runtime.syntheticModules)
        .map(([name, binding]) => [name, binding.descriptor])
    )),
    turn: () => loop.runTurn(),
    drainNextTicks: () => loop.runNextTickCheckpoint().callbacksProcessed > 0
  })
})()
