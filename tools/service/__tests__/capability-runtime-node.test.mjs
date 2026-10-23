import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { HolonomyControlCore } from '../control-core.mjs'
import { createNodeRuntimeAdapter } from '../node-target-adapter.mjs'
import { publicProcessDto } from '../public-process-dto.mjs'
import { ServiceLogStore } from '../service-log-store.mjs'
import { AtomicServiceStateStore } from '../state-store.mjs'
import { createTargetAdapterDispatcher } from '../target-adapters.mjs'

const entryUrl = 'app+local://workspace/main.mjs'

const policy = () => ({
  device: {
    defaultAccess: 'deny',
    maxEventsPerSecond: 1,
    maxQueuedEvents: 0,
    maxSubscriptions: 0,
    operations: {
      'device.form-factor.read': { access: 'allow', maxPrecision: 'standard', maxPrivacyTier: 0 }
    }
  },
  filesystem: {
    access: 'sandboxed',
    limits: {
      maxDirectoryEntries: 32,
      maxOpenHandles: 8,
      maxQueuedEvents: 0,
      maxReadBytes: 4096,
      maxWatchers: 0,
      maxWriteBytes: 4096
    },
    roots: [{
      rights: ['read', 'write'],
      rootId: 'workspace',
      symlinks: 'deny',
      virtualUrl: 'holo-fs://workspace/'
    }]
  },
  schemaVersion: 2,
  systemInformation: {
    defaultMode: 'unavailable',
    fields: { 'os.arch': { allowedModes: ['synthetic'], maxPrecision: 'exact' } }
  }
})

const launch = source => ({
  entryUrl,
  moduleRootUrl: 'app+local://workspace/',
  modules: [{ source, url: entryUrl }],
  schemaVersion: 2,
  target: 'node'
})

const waitForOperation = async (core, id) => {
  for (let turn = 0; turn < 2_000; turn += 1) {
    const operation = core.get('operations', id, 'Operation')
    if (['cancelled', 'failed', 'succeeded'].includes(operation.state)) return operation
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('Capability Runtime operation did not settle')
}

const waitForLog = async (core, id, prefix) => {
  let cursor = 0
  for (let turn = 0; turn < 1_000; turn += 1) {
    const page = await core.readLogs(id, { after: cursor, waitMs: 5 })
    const event = page.events.find(item => item.chunk.startsWith(prefix))
    if (event != null) return event.chunk.slice(prefix.length)
    cursor = page.cursor
  }
  throw new Error(`Capability Runtime log was not observed: ${prefix}`)
}

const request = source => ({
  capabilityRuntime: {
    context: {
      guest: { application: { id: 'service.example', name: 'Service Example' } },
      host: { tenantId: 'private-tenant' },
      inspector: { title: 'Private Inspector Title' },
      schemaVersion: 1
    },
    initialMiddlewareId: 'service.continue.v1',
    sandboxPolicy: policy(),
    schemaVersion: 1
  },
  deviceId: 'node:local',
  entryUrl,
  inspectorMode: 'off',
  isolation: 'runtime',
  launch: launch(source),
  target: 'node'
})

describe('service to Node capability Runtime kernel slice', () => {
  it('runs CDP evaluation through the exact trusted Inspector Gate before V8 compilation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-cdp-gate-'))
    const requests = []
    const engineGate = request => {
      requests.push(request)
      return { action: 'allow' }
    }
    const core = new HolonomyControlCore({
      adapterDispatcher: createTargetAdapterDispatcher({ node: createNodeRuntimeAdapter({ engineGate }) }),
      capabilityEngineGate: engineGate,
      deviceRefreshIntervalMs: 60_000,
      logStore: new ServiceLogStore({ directory: join(directory, 'logs') }),
      outputPollIntervalMs: 5,
      stateDirectory: directory,
      store: new AtomicServiceStateStore({ directory })
    })
    try {
      await core.open()
      await core.refreshDevices()
      const input = request("console.log('M4_CDP_READY')")
      input.inspectorMode = 'enabled'
      input.capabilityRuntime.sandboxPolicy.codeGeneration = {
        dynamicImport: { access: 'none' },
        strings: {
          access: 'controlled',
          decisionTimeoutMs: 1000,
          maxOperations: 4,
          maxSourceBytes: 4096
        },
        wasm: { access: 'none' }
      }
      input.capabilityRuntime.sandboxPolicy.inspector = {
        callFunctionOn: false,
        compileScript: false,
        evaluate: true,
        runScript: false,
        setScriptSource: false
      }
      const started = await core.startProcess(input, 'm4-cdp-start')
      assert.equal((await waitForOperation(core, started.value.operation.id)).state, 'succeeded')
      const processRecord = core.get('processes', started.value.process.id, 'Runtime process')
      const opened = await core.openInspector(
        processRecord.id,
        processRecord.generation,
        {},
        'm4-cdp-open'
      )
      assert.equal((await waitForOperation(core, opened.value.operation.id)).state, 'succeeded')
      const session = core.inspectorProxy().connect(opened.value.inspector.id, () => undefined)
      const response = await session.receive({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: '21 * 2', returnByValue: true }
      })
      assert.equal(response.result.result.value, 42)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].entryDetail.kind, 'inspectorEvaluate')
      assert.equal(requests[0].metadataSupport.entryDetail, 'exact')
      assert.ok(requests.every(item => item.operation === 'runtime.code.generate.strings'))
    } finally {
      await core.close()
      await rm(directory, { recursive: true })
    }
  }, 30_000)

  it('resolves initial Host Runtime Observers before executing the Node entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-observer-'))
    const observerEvents = []
    const core = new HolonomyControlCore({
      capabilityObserverRegistry: {
        'service.script-observer': {
          observer: event => observerEvents.push(event),
          registration: {
            callbackTimeoutMs: 100,
            events: ['script.compiled'],
            maxQueuedEvents: 64
          }
        }
      },
      deviceRefreshIntervalMs: 60_000,
      logStore: new ServiceLogStore({ directory: join(directory, 'logs') }),
      outputPollIntervalMs: 5,
      stateDirectory: directory,
      store: new AtomicServiceStateStore({ directory })
    })
    try {
      await core.open()
      await core.refreshDevices()
      const input = request("console.log('M4_OBSERVER_READY')")
      input.capabilityRuntime.initialObserverIds = ['service.script-observer']
      input.capabilityRuntime.sandboxPolicy.diagnostics = {
        maxObserverCallbackMs: 100,
        maxQueuedEvents: 64,
        maxSourceReadBytes: 0,
        observerEvents: ['script.compiled'],
        retentionMs: 0,
        sourceReader: 'metadataOnly'
      }
      const started = await core.startProcess(input, 'm4-observer')
      assert.equal((await waitForOperation(core, started.value.operation.id)).state, 'succeeded')
      assert.equal(await waitForLog(core, started.value.process.id, 'M4_OBSERVER_READY'), '')
      for (let turn = 0; turn < 100 && observerEvents.length === 0; turn += 1) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const compiled = observerEvents.find(event => event.payload.origin === entryUrl)
      assert.ok(compiled)
      assert.equal(compiled.event, 'script.compiled')
      assert.equal(compiled.generation, 1)
      assert.equal('source' in compiled.payload, false)
    } finally {
      await core.close()
      await rm(directory, { recursive: true })
    }
  })

  it('routes admitted dynamic import through the Host M4 Engine Gate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-engine-gate-'))
    const requests = []
    const sources = []
    const sourceReaderHostCaps = {
      capabilityName: 'host.diagnostics.source.read',
      maxReadBytes: 4096
    }
    const engineGate = async request => {
      requests.push(request)
      sources.push(Buffer.from(await request.sourceReader.read({ maxBytes: 4096 })).toString())
      return { action: 'allow' }
    }
    const core = new HolonomyControlCore({
      adapterDispatcher: createTargetAdapterDispatcher({
        node: createNodeRuntimeAdapter({ engineGate, sourceReaderHostCaps })
      }),
      capabilityEngineGate: engineGate,
      capabilityEngineSourceReaderHostCaps: sourceReaderHostCaps,
      deviceRefreshIntervalMs: 60_000,
      logStore: new ServiceLogStore({ directory: join(directory, 'logs') }),
      outputPollIntervalMs: 5,
      stateDirectory: directory,
      store: new AtomicServiceStateStore({ directory })
    })
    try {
      await core.open()
      await core.refreshDevices()
      const input = request(
        "const lazy = await import('./lazy.mjs'); console.log('M4_DYNAMIC:' + lazy.value)"
      )
      input.launch.modules.push({ source: 'export const value = 42', url: 'app+local://workspace/lazy.mjs' })
      input.capabilityRuntime.sandboxPolicy.codeGeneration = {
        dynamicImport: {
          access: 'controlled',
          decisionTimeoutMs: 1000,
          maxOperations: 2,
          maxSourceBytes: 4096
        },
        strings: { access: 'none' },
        wasm: { access: 'none' }
      }
      input.capabilityRuntime.sandboxPolicy.diagnostics = {
        maxObserverCallbackMs: 1,
        maxQueuedEvents: 0,
        maxSourceReadBytes: 4096,
        observerEvents: [],
        retentionMs: 0,
        sourceReader: 'boundedSource'
      }
      const started = await core.startProcess(input, 'm4-dynamic-import')
      assert.equal((await waitForOperation(core, started.value.operation.id)).state, 'succeeded')
      assert.equal(await waitForLog(core, started.value.process.id, 'M4_DYNAMIC:'), '42')
      assert.equal(requests.length, 1)
      assert.equal(requests[0].operation, 'runtime.module.import')
      assert.equal(requests[0].entryDetail.kind, 'dynamicImport')
      assert.deepEqual(sources, ['export const value = 42'])
    } finally {
      await core.close()
      await rm(directory, { force: true, recursive: true })
    }
  }, 30_000)

  it('atomically runs controlled facades and redacts host launch authority', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-capability-node-'))
    const core = new HolonomyControlCore({
      adapterDispatcher: createTargetAdapterDispatcher({ node: createNodeRuntimeAdapter() }),
      deviceRefreshIntervalMs: 60_000,
      logStore: new ServiceLogStore({ directory: join(directory, 'logs') }),
      outputPollIntervalMs: 5,
      stateDirectory: directory,
      store: new AtomicServiceStateStore({ directory })
    })
    try {
      await core.open()
      await core.refreshDevices()
      const started = await core.startProcess(
        request(`
        import { readFile, readFileSync, writeFile } from 'node:fs'
        import { readFile as readFilePromise } from 'node:fs/promises'
        import { arch } from 'node:os'
        import { getFormFactor } from 'holo:device'
        import { getContext } from 'holo:runtime'

        await new Promise(resolve => setTimeout(resolve, 50))
        const callbackValue = await new Promise((resolve, reject) => {
          readFile('holo-fs://workspace/input.txt', 'utf8', (error, value) => error ? reject(error) : resolve(value))
        })
        const writeCallbackArity = await new Promise((resolve, reject) => {
          writeFile('holo-fs://workspace/output.txt', 'written-by-service-guest', 'utf8', function(error) {
            if (error) reject(error)
            else resolve(arguments.length)
          })
        })
        const value = {
          arch: arch(),
          callbackValue,
          context: getContext(),
          device: getFormFactor(),
          promiseValue: await readFilePromise('holo-fs://workspace/input.txt', 'utf8'),
          syncValue: readFileSync('holo-fs://workspace/input.txt', 'utf8'),
          writeCallbackArity
        }
        console.log('M25_NODE:' + JSON.stringify(value))
      `),
        'capability-node-start'
      )
      const workspace = join(directory, 'capability-workspaces', started.value.process.id)
      await mkdir(workspace, { recursive: true })
      await writeFile(join(workspace, 'input.txt'), 'service-host-input')
      const operation = await waitForOperation(core, started.value.operation.id)
      assert.equal(operation.state, 'succeeded')
      const output = JSON.parse(await waitForLog(core, started.value.process.id, 'M25_NODE:'))
      assert.deepEqual(output, {
        arch: process.arch,
        callbackValue: 'service-host-input',
        context: { application: { id: 'service.example', name: 'Service Example' } },
        device: { observedAt: 0, precision: 'standard', revision: 1, status: 'available', value: 'server' },
        promiseValue: 'service-host-input',
        syncValue: 'service-host-input',
        writeCallbackArity: 1
      })
      assert.equal(await readFile(join(workspace, 'output.txt'), 'utf8'), 'written-by-service-guest')

      const internal = core.get('processes', started.value.process.id, 'Runtime process')
      const publicProcess = publicProcessDto(internal)
      assert.equal(publicProcess.capabilityRuntimeState, 'provider-v1')
      assert.match(publicProcess.capabilityContextDigest, /^[\da-f]{64}$/u)
      assert.match(publicProcess.capabilityPolicyDigest, /^[\da-f]{64}$/u)
      const serialized = JSON.stringify(publicProcess)
      for (const secret of ['private-tenant', 'Private Inspector Title', 'holonomy-service', workspace]) {
        assert.equal(serialized.includes(secret), false)
      }

      const restarted = await core.restartProcess(internal.id, internal.generation, 'capability-node-restart')
      assert.equal((await waitForOperation(core, restarted.value.operation.id)).state, 'succeeded')
      const generationTwo = core.get('processes', internal.id, 'Runtime process')
      assert.equal(generationTwo.generation, 2)
      assert.equal(generationTwo.capabilityRuntime.contextDigest, internal.capabilityRuntime.contextDigest)
      assert.equal(generationTwo.capabilityRuntime.policyDigest, internal.capabilityRuntime.policyDigest)
      const stopped = await core.stopProcess(generationTwo.id, generationTwo.generation, 'capability-node-stop')
      assert.equal((await waitForOperation(core, stopped.value.operation.id)).state, 'succeeded')
    } finally {
      await core.close()
      await rm(directory, { force: true, recursive: true })
    }
  }, 30_000)

  it('rejects an unavailable initial middleware before creating a process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-capability-reject-'))
    const core = new HolonomyControlCore({
      adapterDispatcher: createTargetAdapterDispatcher({ node: createNodeRuntimeAdapter() }),
      deviceRefreshIntervalMs: 60_000,
      logStore: new ServiceLogStore({ directory: join(directory, 'logs') }),
      stateDirectory: directory,
      store: new AtomicServiceStateStore({ directory })
    })
    try {
      await core.open()
      await core.refreshDevices()
      const input = request('console.log("ENTRY_SIDE_EFFECT")')
      input.capabilityRuntime.initialMiddlewareId = 'missing.middleware'
      await assert.rejects(
        core.startProcess(input, 'capability-invalid-middleware'),
        error => error.code === 'service.invalid_request'
      )
      assert.equal(core.list('processes').length, 0)
    } finally {
      await core.close()
      await rm(directory, { force: true, recursive: true })
    }
  })
})
