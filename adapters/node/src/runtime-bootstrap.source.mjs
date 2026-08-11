/* eslint-disable antfu/no-top-level-await -- Module evaluation must not complete before the shared Runtime bootstrap. */

import { RuntimeEventLoop } from './modules/event-loop/index.js'
import { createRuntimeConsole } from './modules/runtime-console/index.js'
import { createHolonomyRuntime } from './modules/runtime/index.js'
import { createRuntimeTimers } from './modules/timers/index.js'
import { NetworkMockRouter } from './modules/web-network/network-mock-router.js'
import { RuntimeTextDecoder, RuntimeURL, RuntimeURLSearchParams } from './runtime-web-standards.mjs'

const host = globalThis.__holonomyNodeHost
if (host == null) throw new Error('Node Runtime host is unavailable')
delete globalThis.__holonomyNodeHost
const configuration = JSON.parse(host.configuration())

globalThis.URL = RuntimeURL
globalThis.URLSearchParams = RuntimeURLSearchParams
globalThis.TextDecoder = RuntimeTextDecoder

const eventLoop = new RuntimeEventLoop({
  checkpointMicrotasks() {},
  now: () => host.now(),
  requestWakeup: deadline => host.requestWakeup(deadline),
  terminate: reason => host.terminate(JSON.stringify(reason))
})
host.registerTurn(() => eventLoop.runTurn())

const timers = createRuntimeTimers({
  cancel: timerId => host.cancelTimer(timerId),
  schedule: (delay, interval) => host.scheduleTimer(delay, interval)
})
host.registerTimerFire(timerId => timers.fire(timerId))

const runtimeConsole = createRuntimeConsole({
  write: (level, message) => host.writeOutput(level, message)
})

const sha256Chunks = chunks => host.sha256Chunks(chunks)

const nativePort = Object.freeze({
  cancel: (callToken, reason) => host.cancelNative(callToken, reason),
  closeResource: (owner, provider, reason) => host.closeNativeResource(owner, provider, reason),
  dispatch: (request, context, sink, resourceSink) => host.nativeDispatch(request, context, sink, resourceSink),
  dispose: () => host.disposeNative(),
  grantCredits: (callToken, credits) => host.grantNativeCredits(callToken, credits)
})

const sandboxPlan = configuration.sandboxPlan
const networkEnabled = sandboxPlan.access !== 'none'
const networkPort = networkEnabled
  ? new NetworkMockRouter({
    authority: sandboxPlan.authority,
    bodySha256: body => sha256Chunks([body]),
    bodySha256Chunks: sha256Chunks,
    initialRules: configuration.networkRules,
    passthrough: nativePort
  })
  : nativePort

if (networkEnabled) {
  host.registerRuleUpdater(json => {
    networkPort.rules.replace(JSON.parse(json))
    return true
  })
}

const base64 = source => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = source.replace(/=+$/u, '')
  const bytes = []
  let buffer = 0
  let bits = 0
  for (const character of clean) {
    const digit = alphabet.indexOf(character)
    if (digit < 0) throw new TypeError('Invalid module bytes')
    buffer = (buffer << 6) | digit
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xFF)
    }
  }
  return new Uint8Array(bytes)
}

const readModule = canonicalUrl => {
  const encoded = host.readModule(canonicalUrl)
  if (encoded == null) return null
  const source = JSON.parse(encoded)
  return { bytes: base64(source.base64), sha256: source.sha256 }
}

const nodeCore = {
  ...configuration.nodeCore,
  processControl: { exit: code => host.terminate(`process.exit(${String(code)})`) },
  stdio: { write: (stream, chunk) => host.writeOutput(stream, String(chunk)) },
  webStandards: { URL: RuntimeURL, URLSearchParams: RuntimeURLSearchParams }
}

const runtime = await createHolonomyRuntime({
  authority: {
    capabilities: sandboxPlan.capabilities,
    principal: sandboxPlan.principal
  },
  console: runtimeConsole,
  eventLoop,
  moduleLoader: { readModule, rootUrl: configuration.moduleRootUrl },
  nativePort: networkPort,
  ...(networkEnabled
    ? {
      network: {
        authority: sandboxPlan.authority,
        diagnostics: { emit: event => host.networkDiagnostic(JSON.stringify(event)) },
        diagnosticsBodyLimitBytes: 2 * 1024 * 1024,
        principal: sandboxPlan.principal
      }
    }
    : {}),
  nodeCore,
  testPlatform: 'node',
  timers
})

if (host.installSyntheticModules(runtime.syntheticModules) !== true) {
  throw new Error('Node Runtime synthetic registry installation failed')
}
for (const [name, value] of Object.entries(runtime.globals)) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: false,
    value,
    writable: true
  })
}

const plan = await runtime.moduleLoader.createPlan(configuration.userEntryUrl)
if (!plan.modules.some(module => module.url === configuration.userEntryUrl)) {
  throw new Error('Node Runtime entry is absent from the module plan')
}
host.registerDispose(() => runtime.dispose())
await import(configuration.userEntryUrl)
