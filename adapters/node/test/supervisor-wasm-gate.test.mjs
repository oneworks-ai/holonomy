import assert from 'node:assert/strict'
import process from 'node:process'
// eslint-disable-next-line test/no-import-node-test -- This adapter is verified with Node's public test runner.
import test from 'node:test'

import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'
import { capabilityRuntimeSession } from './capability-runtime-fixture.mjs'

const controlledWasmSession = (source, overrides = {}) =>
  capabilityRuntimeSession({
    codeGeneration: {
      dynamicImport: { access: 'none' },
      strings: { access: 'none' },
      wasm: {
        access: 'controlled',
        decisionTimeoutMs: overrides.decisionTimeoutMs ?? 1000,
        maxOperations: overrides.maxOperations ?? 4,
        maxSourceBytes: overrides.maxSourceBytes ?? 1024
      }
    },
    entryUrl: 'app://fixture/main.mjs',
    hostPath: process.cwd(),
    moduleRootUrl: 'app://fixture/',
    source
  })

test('gates async and streaming Wasm entrypoints exactly once per compilation or instantiation', async t => {
  const requests = []
  const logs = []
  const supervisor = new NodeRuntimeSupervisor({
    engineGate: request => {
      requests.push(request)
      return { action: 'allow' }
    },
    requestTimeoutMs: 5_000
  })
  t.after(() => supervisor.stop())
  supervisor.on('log', event => logs.push(event))

  const status = await supervisor.start(controlledWasmSession(
    `
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
    const compiled = await WebAssembly.compile(bytes)
    const fromModule = await WebAssembly.instantiate(compiled)
    const fromBytes = await WebAssembly.instantiate(bytes)
    const streamedModule = await WebAssembly.compileStreaming(Promise.resolve({
      async arrayBuffer() { return bytes.buffer }
    }))
    const streamedInstance = await WebAssembly.instantiateStreaming(Promise.resolve({
      async arrayBuffer() { return bytes.buffer }
    }))
    console.log('WASM_ASYNC:' + [
      compiled instanceof WebAssembly.Module,
      fromModule instanceof WebAssembly.Instance,
      fromBytes.module instanceof WebAssembly.Module,
      streamedModule instanceof WebAssembly.Module,
      streamedInstance.instance instanceof WebAssembly.Instance
    ].join(':'))
  `,
    { maxOperations: 5 }
  ))

  assert.equal(requests.length, 5)
  assert.ok(requests.every(request => request.operation === 'runtime.code.generate.wasm'))
  assert.ok(requests.every(request => request.sourceBytes === 8))
  assert.equal(status.engineGate.wasmCallbacks, 5)
  assert.ok(logs.some(event => event.text === 'WASM_ASYNC:true:true:true:true:true'))
})
