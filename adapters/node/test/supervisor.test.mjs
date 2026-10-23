import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import process from 'node:process'
// eslint-disable-next-line test/no-import-node-test -- This adapter is verified with Node's public test runner.
import test from 'node:test'

import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'
import { capabilityRuntimeSession } from './capability-runtime-fixture.mjs'

const createSession = (message, overrides = {}) => ({
  entryUrl: 'app://fixture/main.mjs',
  runtimeModules: [],
  syntheticModules: {},
  userModules: [{ source: `console.log(${JSON.stringify(message)})`, url: 'app://fixture/main.mjs' }],
  ...overrides
})

const controlledStringSession = (source, overrides = {}) => {
  const entryUrl = 'app://fixture/main.mjs'
  return capabilityRuntimeSession({
    codeGeneration: {
      dynamicImport: { access: 'none' },
      strings: {
        access: 'controlled',
        decisionTimeoutMs: overrides.decisionTimeoutMs ?? 1000,
        maxOperations: overrides.maxOperations ?? 4,
        maxSourceBytes: overrides.maxSourceBytes ?? 1024
      },
      wasm: { access: 'none' }
    },
    ...(overrides.diagnostics == null ? {} : { diagnostics: overrides.diagnostics }),
    entryUrl,
    hostPath: process.cwd(),
    moduleRootUrl: 'app://fixture/',
    source
  })
}

const controlledDynamicImportSession = source =>
  capabilityRuntimeSession({
    additionalUserModules: [{ source, url: 'app://fixture/lazy.mjs' }],
    codeGeneration: {
      dynamicImport: {
        access: 'controlled',
        decisionTimeoutMs: 1000,
        maxOperations: 2,
        maxSourceBytes: 1024
      },
      strings: { access: 'none' },
      wasm: { access: 'none' }
    },
    entryUrl: 'app://fixture/main.mjs',
    hostPath: process.cwd(),
    moduleRootUrl: 'app://fixture/',
    source: "const loaded = await import('./lazy.mjs'); console.log('DYNAMIC:' + loaded.value)"
  })

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

test('routes controlled string compilation through the Host Engine Gate exactly once', async t => {
  const requests = []
  const supervisor = new NodeRuntimeSupervisor({
    engineGate: async request => {
      requests.push(request)
      return { action: 'allow' }
    },
    requestTimeoutMs: 5_000
  })
  t.after(() => supervisor.stop())
  const session = controlledStringSession("console.log(eval('6 * 7'))")
  const logs = []
  supervisor.on('log', event => logs.push(event))

  const status = await supervisor.start(session)
  assert.equal(status.engineGate.stringsCallbacks, 1)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].operation, 'runtime.code.generate.strings')
  assert.equal(requests[0].metadataSupport.source, 'available')
  assert.equal(requests[0].sourceBytes, 5)
  assert.match(requests[0].sourceSha256, /^[\da-f]{64}$/u)
  assert.ok(logs.some(event => event.text === '42'))
})

test('offers a one-shot bounded Engine source reader only with explicit Host capability', async t => {
  const reads = []
  const supervisor = new NodeRuntimeSupervisor({
    engineGate: async request => {
      assert.ok(request.sourceReader)
      reads.push(Buffer.from(await request.sourceReader.read({ maxBytes: 4 })).toString())
      await assert.rejects(
        request.sourceReader.read({ maxBytes: 4 }),
        { code: 'engine_source_reader_unavailable' }
      )
      return { action: 'allow' }
    },
    requestTimeoutMs: 5_000,
    sourceReaderHostCaps: {
      capabilityName: 'host.diagnostics.source.read',
      maxReadBytes: 8
    }
  })
  t.after(() => supervisor.stop())
  await supervisor.start(controlledStringSession("console.log(eval('1234 + 1'))", {
    diagnostics: {
      maxObserverCallbackMs: 1,
      maxQueuedEvents: 0,
      maxSourceReadBytes: 6,
      observerEvents: [],
      retentionMs: 0,
      sourceReader: 'boundedSource'
    }
  }))

  assert.deepEqual(reads, ['1234'])
})

test('fails closed on Host denial, deadline, source limit, and operation limit', async t => {
  const supervisors = []
  t.after(() => Promise.all(supervisors.map(supervisor => supervisor.stop())))
  const run = async (engineGate, session) => {
    const supervisor = new NodeRuntimeSupervisor({ engineGate, requestTimeoutMs: 5_000 })
    supervisors.push(supervisor)
    await assert.rejects(() => supervisor.start(session), { code: 'start_failed.entry_evaluation' })
  }

  let denied = 0
  await run(
    () => {
      denied += 1
      return { action: 'deny', reasonCode: 'test.denied' }
    },
    controlledStringSession("eval('globalThis.deniedSideEffect = true')")
  )
  assert.equal(denied, 1)

  let timedOut = 0
  let aborted = 0
  let lateSettled = 0
  await run(
    request => {
      timedOut += 1
      return new Promise(resolve => {
        request.signal.addEventListener('abort', () => {
          aborted += 1
          setTimeout(() => {
            lateSettled += 1
            resolve({ action: 'allow' })
          }, 10)
        }, { once: true })
      })
    },
    controlledStringSession("eval('globalThis.timeoutSideEffect = true')", { decisionTimeoutMs: 20 })
  )
  assert.equal(timedOut, 1)
  assert.equal(aborted, 1)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(lateSettled, 1)

  let overLimit = 0
  await run(
    () => {
      overLimit += 1
      return { action: 'allow' }
    },
    controlledStringSession("eval('123')", { maxSourceBytes: 2 })
  )
  assert.equal(overLimit, 0)

  let operations = 0
  await run(
    () => {
      operations += 1
      return { action: 'allow' }
    },
    controlledStringSession("eval('1'); eval('2')", { maxOperations: 1 })
  )
  assert.equal(operations, 1)
})

test('cancels an in-flight Host Engine Gate when the runtime stops', async () => {
  let entered
  let observedSignal
  const gateEntered = new Promise(resolve => {
    entered = resolve
  })
  const supervisor = new NodeRuntimeSupervisor({
    engineGate: request => {
      observedSignal = request.signal
      entered()
      return new Promise(resolve => {
        request.signal.addEventListener('abort', () => resolve({ action: 'allow' }), { once: true })
      })
    },
    requestTimeoutMs: 1_000
  })
  const starting = supervisor
    .start(controlledStringSession("eval('globalThis.stoppedSideEffect = true')", { decisionTimeoutMs: 5_000 }))
    .catch(error => error)
  await gateEntered
  await supervisor.stop()
  const startTerminal = await starting

  assert.equal(observedSignal.aborted, true)
  assert.ok(startTerminal instanceof Error)
  assert.equal(supervisor.state, 'stopped')
})

test('delivers bounded Host-only Runtime Observer events and fences them by generation', async t => {
  const events = []
  const diagnostics = []
  const binding = {
    bindingId: 'observer-script',
    observer: event => events.push(event),
    ownerId: 'node-host',
    registration: {
      callbackTimeoutMs: 100,
      events: ['script.compiled'],
      maxQueuedEvents: 64
    },
    version: '1'
  }
  const supervisor = new NodeRuntimeSupervisor({
    observerBindings: [binding],
    observerHostCaps: { maxObserverCallbackMs: 100, maxQueuedEvents: 64 },
    requestTimeoutMs: 5_000
  })
  t.after(() => supervisor.stop())
  supervisor.on('observerDiagnostic', event => diagnostics.push(event))
  const session = capabilityRuntimeSession({
    diagnostics: {
      maxObserverCallbackMs: 100,
      maxQueuedEvents: 64,
      maxSourceReadBytes: 0,
      observerEvents: ['script.compiled'],
      retentionMs: 0,
      sourceReader: 'metadataOnly'
    },
    entryUrl: 'app://fixture/main.mjs',
    hostPath: process.cwd(),
    initialObservers: [{ bindingId: 'observer-script', ownerId: 'node-host', version: '1' }],
    moduleRootUrl: 'app://fixture/',
    source: "console.log('OBSERVED')"
  })

  await supervisor.start(session)
  for (let turn = 0; turn < 20 && events.length === 0; turn += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const compiled = events.find(event => event.payload.origin === 'app://fixture/main.mjs')
  assert.ok(compiled)
  assert.equal(compiled.event, 'script.compiled')
  assert.equal(compiled.generation, 1)
  assert.equal(compiled.schemaVersion, 1)
  assert.equal(compiled.payload.sourceBytes, 23)
  assert.match(compiled.payload.sourceSha256, /^[\da-f]{64}$/u)
  assert.equal('source' in compiled.payload, false)
  assert.deepEqual(diagnostics, [])

  events.length = 0
  await supervisor.restart(session)
  for (let turn = 0; turn < 20 && events.length === 0; turn += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(events.length > 0)
  assert.ok(events.every(event => event.generation === 2))
})

test('rejects missing initial Runtime Observer bindings before entry execution', async t => {
  const session = capabilityRuntimeSession({
    diagnostics: {
      maxObserverCallbackMs: 100,
      maxQueuedEvents: 8,
      maxSourceReadBytes: 0,
      observerEvents: ['script.compiled'],
      retentionMs: 0,
      sourceReader: 'metadataOnly'
    },
    entryUrl: 'app://fixture/main.mjs',
    hostPath: process.cwd(),
    initialObservers: [{ bindingId: 'missing-observer', ownerId: 'node-host', version: '1' }],
    moduleRootUrl: 'app://fixture/',
    source: "console.log('MUST_NOT_RUN')"
  })
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event))

  await assert.rejects(() => supervisor.start(session), { code: 'observer_binding_unavailable' })
  assert.equal(logs.some(event => event.text === 'MUST_NOT_RUN'), false)
})

test('gates dynamic import before compiling the resolved module', async t => {
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

  await supervisor.start(controlledDynamicImportSession('export const value = 42'))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].operation, 'runtime.module.import')
  assert.equal(requests[0].entryDetail.kind, 'dynamicImport')
  assert.equal(requests[0].origin, 'app://fixture/lazy.mjs')
  assert.equal(requests[0].sourceBytes, 23)
  assert.match(requests[0].sourceSha256, /^[\da-f]{64}$/u)
  assert.ok(logs.some(event => event.text === 'DYNAMIC:42'))
})

test('gates Wasm compilation and instantiation with staged BufferSource limits', async t => {
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

  const status = await supervisor.start(controlledWasmSession(`
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
    const module = new WebAssembly.Module(bytes)
    const instance = new WebAssembly.Instance(module)
    console.log('WASM:' + (module instanceof WebAssembly.Module) + ':' +
      (instance instanceof WebAssembly.Instance) + ':' +
      (WebAssembly.Module.prototype.constructor === WebAssembly.Module))
  `))

  assert.equal(requests.length, 2)
  assert.ok(requests.every(request => request.operation === 'runtime.code.generate.wasm'))
  assert.ok(requests.every(request => request.metadataSupport.source === 'available'))
  assert.ok(requests.every(request => request.sourceBytes === 8))
  assert.equal(status.engineGate.wasmCallbacks, 2)
  assert.ok(logs.some(event => event.text === 'WASM:true:true:true'))

  let oversizedRequests = 0
  const oversized = new NodeRuntimeSupervisor({
    engineGate: () => {
      oversizedRequests += 1
      return { action: 'allow' }
    },
    requestTimeoutMs: 5_000
  })
  t.after(() => oversized.stop())
  await assert.rejects(
    oversized.start(controlledWasmSession(
      'new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))',
      { maxSourceBytes: 7 }
    )),
    { code: 'start_failed.entry_evaluation' }
  )
  assert.equal(oversizedRequests, 0)

  let operationRequests = 0
  const operationLimited = new NodeRuntimeSupervisor({
    engineGate: () => {
      operationRequests += 1
      return { action: 'allow' }
    },
    requestTimeoutMs: 5_000
  })
  t.after(() => operationLimited.stop())
  await assert.rejects(
    operationLimited.start(controlledWasmSession(
      `
      const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
      new WebAssembly.Instance(module)
    `,
      { maxOperations: 1 }
    )),
    { code: 'start_failed.entry_evaluation' }
  )
  assert.equal(operationRequests, 1)
})

test('rejects unsafe Wasm BufferSource shapes without executing Guest traps or entering the Host Gate', async t => {
  let requests = 0
  const logs = []
  const supervisor = new NodeRuntimeSupervisor({
    engineGate: () => {
      requests += 1
      return { action: 'allow' }
    },
    requestTimeoutMs: 5_000
  })
  t.after(() => supervisor.stop())
  supervisor.on('log', event => logs.push(event))

  await supervisor.start(controlledWasmSession(`
    let traps = 0
    const target = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
    const proxy = new Proxy(target, { get() { traps += 1; return undefined } })
    let proxyRejected = false
    let sharedRejected = false
    try { new WebAssembly.Module(proxy) } catch { proxyRejected = true }
    try { new WebAssembly.Module(new Uint8Array(new SharedArrayBuffer(8))) } catch { sharedRejected = true }
    console.log('WASM_UNSAFE:' + proxyRejected + ':' + sharedRejected + ':' + traps)
  `))

  assert.equal(requests, 0)
  assert.ok(logs.some(event => event.text === 'WASM_UNSAFE:true:true:0'))
})

test('keeps vm, Worker, native loaders, and non-graph module schemes unreachable', async t => {
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event))

  await supervisor.start(createSession('', {
    userModules: [{
      source: `console.log('ESCAPES:' + [
        typeof process,
        typeof require,
        typeof Worker,
        typeof ShadowRealm
      ].join(':'))`,
      url: 'app://fixture/main.mjs'
    }]
  }))
  assert.ok(logs.some(event => event.text === 'ESCAPES:undefined:undefined:undefined:undefined'))

  for (
    const specifier of [
      'node:vm',
      'node:worker_threads',
      'data:text/javascript,export default 1',
      'blob:https://fixture.invalid/module',
      'file:///tmp/module.mjs'
    ]
  ) {
    await supervisor.stop()
    await assert.rejects(
      supervisor.start(createSession('', {
        userModules: [{
          source: `import ${JSON.stringify(specifier)}`,
          url: 'app://fixture/main.mjs'
        }]
      })),
      { code: 'start_failed.entry_evaluation' }
    )
  }
})
