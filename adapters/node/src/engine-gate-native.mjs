import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import process from 'node:process'

const require = createRequire(import.meta.url)
const ADDON_PATH = '../native/engine-gate/build/Release/holonomy_engine_gate.node'
const deniedPolicy = Object.freeze({ access: 'none' })
let nextContextId = 0

const access = value => value?.access === 'controlled' ? 'controlled' : 'none'

const loadAddon = () => {
  try {
    return require(ADDON_PATH)
  } catch {
    return undefined
  }
}

export const reserveNodeEngineGateContextV1 = sandbox => {
  const contextId = ++nextContextId
  Object.defineProperty(sandbox, '__holonomyEngineGateContextId', {
    configurable: false,
    enumerable: false,
    value: contextId,
    writable: false
  })
  return contextId
}

export const installNodeEngineGateV1 = (contextId, codeGeneration = {}) => {
  const policy = Object.freeze({
    strings: codeGeneration.strings ?? deniedPolicy,
    wasm: codeGeneration.wasm ?? deniedPolicy
  })
  const stringsControlled = access(policy.strings) === 'controlled'
  const wasmControlled = access(policy.wasm) === 'controlled'
  const controlled = stringsControlled || wasmControlled
  const addon = loadAddon()
  if (addon == null) {
    if (controlled) throw new Error('Node per-compilation Engine Gate is unavailable')
    return Object.freeze({
      mode: 'generation-level',
      snapshot: () =>
        Object.freeze({
          installed: false,
          stringsCallbacks: 0,
          wasmCallbacks: 0
        })
    })
  }
  const requestFd = Number.parseInt(process.env.HOLO_ENGINE_GATE_REQUEST_FD ?? '0', 10)
  const responseFd = Number.parseInt(process.env.HOLO_ENGINE_GATE_RESPONSE_FD ?? '0', 10)
  if (
    controlled && (!Number.isInteger(requestFd) || requestFd < 3 || !Number.isInteger(responseFd) || responseFd < 3)
  ) {
    throw new Error('Node Host Engine Gate decision transport is unavailable')
  }
  const defaults = Object.freeze({ decisionTimeoutMs: 1, maxOperations: 1, maxSourceBytes: 1 })
  const strings = stringsControlled ? policy.strings : defaults
  const wasm = wasmControlled ? policy.wasm : defaults
  const configuration = {
    contextId,
    requestFd,
    responseFd,
    strings: stringsControlled ? 'host' : 'deny',
    stringsMaxOperations: strings.maxOperations,
    stringsMaxSourceBytes: strings.maxSourceBytes,
    stringsTimeoutMs: strings.decisionTimeoutMs,
    wasm: wasmControlled ? 'host' : 'deny',
    wasmMaxOperations: wasm.maxOperations,
    wasmMaxSourceBytes: wasm.maxSourceBytes,
    wasmTimeoutMs: wasm.decisionTimeoutMs
  }
  addon.configure(configuration)
  return Object.freeze({
    mode: 'native-per-compilation',
    snapshot: () => Object.freeze({ ...addon.snapshot(contextId) }),
    ...(wasmControlled
      ? {
        requestWasm: source => addon.requestWasm(contextId, source),
        stageWasmSource: source => addon.stageWasmSource(contextId, source)
      }
      : {})
  })
}

// This is Host-only: the verified v86 asset is compiled synchronously in the
// Node realm, and the native callback consumes its permit on that exact realm.
// Neither the addon nor this function is installed in the Guest Context.
export const instantiateVerifiedNodeHostWasmV1 = (source, expectedSha256, imports) => {
  if (!(source instanceof ArrayBuffer) || !/^[a-f\d]{64}$/u.test(expectedSha256)) {
    throw new TypeError('Invalid verified Host Wasm source')
  }
  const snapshot = Uint8Array.from(new Uint8Array(source))
  if (createHash('sha256').update(snapshot).digest('hex') !== expectedSha256) {
    throw new TypeError('Host Wasm source digest mismatch')
  }
  const addon = loadAddon()
  if (addon?.isInstalled?.() !== true) {
    return new WebAssembly.Instance(new WebAssembly.Module(snapshot), imports).exports
  }
  if (addon?.stageHostWasmSource == null || addon?.clearHostWasmSource == null) {
    throw new Error('Node Host Wasm Engine Gate is unavailable')
  }
  addon.stageHostWasmSource(snapshot)
  let module
  try {
    module = new WebAssembly.Module(snapshot)
  } finally {
    addon.clearHostWasmSource()
  }
  return new WebAssembly.Instance(module, imports).exports
}
