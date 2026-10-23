import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
// eslint-disable-next-line test/no-import-node-test -- Native hooks require the real Node isolate.
import { test } from 'node:test'
import vm from 'node:vm'

import { instantiateVerifiedNodeHostWasmV1 } from '../src/engine-gate-native.mjs'

const require = createRequire(import.meta.url)
const gate = require('../native/engine-gate/build/Release/holonomy_engine_gate.node')
let nextContextId = 0
const configure = (context, options) => {
  const contextId = context.__holonomyEngineGateContextId
  const configuration = {
    contextId,
    requestFd: 0,
    responseFd: 0,
    stringsMaxOperations: 100,
    stringsMaxSourceBytes: 1024 * 1024,
    stringsTimeoutMs: 1000,
    wasmMaxOperations: 100,
    wasmMaxSourceBytes: 1024 * 1024,
    wasmTimeoutMs: 1000,
    ...options
  }
  gate.configure(configuration)
  return {
    snapshot: () => gate.snapshot(contextId)
  }
}

const createControlledContext = () => {
  const sandbox = Object.create(null)
  Object.defineProperty(sandbox, '__holonomyEngineGateContextId', {
    configurable: false,
    enumerable: false,
    value: ++nextContextId,
    writable: false
  })
  return vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
    name: 'holonomy-engine-gate-corpus'
  })
}

test('native string hook gates every supported string compiler without changing eval semantics', async () => {
  const context = createControlledContext()
  const control = configure(context, { strings: 'allow', wasm: 'deny' })

  assert.equal(
    vm.runInContext(
      `(() => {
    const lexical = 7
    return eval('lexical')
  })()`,
      context
    ),
    7
  )
  assert.equal(
    vm.runInContext(
      `(() => {
    const lexical = 7
    globalThis.lexical = 11
    return (0, eval)('lexical')
  })()`,
      context
    ),
    11
  )
  assert.equal(vm.runInContext("Function('return 13')()", context), 13)
  assert.equal(
    await vm.runInContext("Object.getPrototypeOf(async function(){}).constructor('return 17')()", context),
    17
  )
  assert.equal(
    vm.runInContext("Object.getPrototypeOf(function*(){}).constructor('yield 19')().next().value", context),
    19
  )
  assert.equal(
    (await vm.runInContext(
      "Object.getPrototypeOf(async function*(){}).constructor('yield 23')().next()",
      context
    )).value,
    23
  )

  assert.deepEqual(control.snapshot(), {
    installed: true,
    stringsCallbacks: 6,
    wasmCallbacks: 0
  })
})

test('native string hook denies eval and constructors without running generated code', () => {
  const context = createControlledContext()
  const control = configure(context, { strings: 'deny', wasm: 'deny' })

  assert.throws(
    () => vm.runInContext("eval('globalThis.sideEffect = true')", context),
    error =>
      error?.name === 'EvalError' && error?.message === 'Code generation from strings disallowed for this context'
  )
  assert.throws(
    () => vm.runInContext("Function('globalThis.sideEffect = true')()", context),
    error =>
      error?.name === 'EvalError' && error?.message === 'Code generation from strings disallowed for this context'
  )
  assert.equal(context.sideEffect, undefined)
  assert.equal(control.snapshot().stringsCallbacks, 2)
})

test('native Wasm hook independently allows or denies each compilation', async () => {
  const moduleSource = 'new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))'

  const allowedContext = createControlledContext()
  const allowed = configure(allowedContext, { strings: 'deny', wasm: 'allow' })
  gate.stageWasmSource(
    allowedContext.__holonomyEngineGateContextId,
    new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
  )
  assert.equal(
    vm.runInContext(`Object.prototype.toString.call(${moduleSource})`, allowedContext),
    '[object WebAssembly.Module]'
  )
  assert.deepEqual(allowed.snapshot(), {
    installed: true,
    stringsCallbacks: 0,
    wasmCallbacks: 1
  })

  const deniedContext = createControlledContext()
  const denied = configure(deniedContext, { strings: 'deny', wasm: 'deny' })
  assert.throws(
    () => vm.runInContext(moduleSource, deniedContext),
    error => error?.name === 'CompileError'
  )
  assert.equal(denied.snapshot().wasmCallbacks, 1)
})

test('Host v86 Wasm permit is pinned, one-shot, and unavailable to Guest Contexts', () => {
  const bytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0])
  const digest = createHash('sha256').update(bytes).digest('hex')
  const guest = createControlledContext()
  configure(guest, { strings: 'deny', wasm: 'deny' })

  assert.throws(() => instantiateVerifiedNodeHostWasmV1(bytes.buffer, '0'.repeat(64), {}), TypeError)
  assert.equal(typeof instantiateVerifiedNodeHostWasmV1(bytes.buffer, digest, {}), 'object')
  assert.throws(() => new WebAssembly.Module(bytes), error => error?.name === 'CompileError')

  gate.stageHostWasmSource(bytes)
  assert.throws(
    () => vm.runInContext('new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))', guest),
    error => error?.name === 'CompileError'
  )
  guest.HostModule = WebAssembly.Module
  assert.throws(
    () => vm.runInContext('new HostModule(new Uint8Array([0,97,115,109,1,0,0,0]))', guest),
    error => error?.name === 'CompileError'
  )
  assert.ok(new WebAssembly.Module(bytes) instanceof WebAssembly.Module)
  assert.throws(() => new WebAssembly.Module(bytes), error => error?.name === 'CompileError')

  guest.stageHostWasmSource = gate.stageHostWasmSource
  assert.throws(
    () => vm.runInContext('stageHostWasmSource(new Uint8Array([0,97,115,109,1,0,0,0]))', guest),
    error => error?.name === 'TypeError'
  )
  assert.throws(() => new WebAssembly.Module(bytes), error => error?.name === 'CompileError')
})
