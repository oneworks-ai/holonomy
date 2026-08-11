import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { createAdbPort } from '../adb-port.mjs'
import { createAndroidRuntimeAdapter } from '../android-target-adapter.mjs'
import { HolonomyControlCore } from '../control-core.mjs'
import { serviceError } from '../errors.mjs'
import { ControlRegistry } from '../registry.mjs'
import { ServiceLogStore } from '../service-log-store.mjs'
import { AtomicServiceStateStore } from '../state-store.mjs'
import { restrictedSandboxPolicy } from './sandbox-fixture.mjs'

const waitForOperation = async (core, id) => {
  for (let turn = 0; turn < 2_000; turn += 1) {
    const operation = core.get('operations', id, 'Operation')
    if (['cancelled', 'failed', 'succeeded'].includes(operation.state)) return operation
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  const operation = core.get('operations', id, 'Operation')
  throw new Error(`Operation did not settle: ${
    JSON.stringify({
      operation,
      process: core.get('processes', operation.target.id, 'Runtime process')
    })
  }`)
}

const createHarness = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-core-'))
  const calls = []
  const startInputs = []
  const terminalListeners = new Map()
  const adbPort = createAdbPort({
    applyNetworkRules: async input => calls.push(`rules:${input.networkRules.ruleRevision}`),
    closeInspector: async input => calls.push(`close-inspector:${input.inspector.id}`),
    listDevices:
      async () => [{ id: 'android:emulator-5554', kind: 'emulator', serial: 'emulator-5554', state: 'online' }],
    openInspector: async input => ({
      discoveryUrl: `http://127.0.0.1:9229/${input.process.generation}`,
      localPort: 9_229,
      targetSession: input.process.generation
    }),
    readLogs: async input =>
      input.after >= 1
        ? { cursor: input.after, events: [] }
        : { cursor: 1, events: [{ chunk: 'ready', sequence: 1, stream: 'stdout' }] },
    removeNetworkRules: async input => calls.push(`remove-rules:${input.networkRules.ruleRevision}`),
    removeProcess: async input => calls.push(`remove:${input.process.generation}`),
    startProcess: async input => {
      calls.push(`start:${input.process.generation}`)
      startInputs.push(input)
      return { waitingForDebugger: input.process.inspectorMode === 'break' }
    },
    stopProcess: async input => calls.push(`stop:${input.process.generation}`),
    subscribeProcess: ({ onTerminal, process }) => {
      const key = `${process.id}:${process.generation}`
      terminalListeners.set(key, onTerminal)
      return () => terminalListeners.delete(key)
    }
  })
  const core = new HolonomyControlCore({
    adbPort,
    logStore: new ServiceLogStore({ directory: join(directory, 'logs') }),
    store: new AtomicServiceStateStore({ directory })
  })
  await core.open()
  await core.refreshDevices()
  return {
    calls,
    close: async () => {
      await core.close()
      await rm(directory, { force: true, recursive: true })
    },
    core,
    startInputs,
    terminal(process, event) {
      terminalListeners.get(`${process.id}:${process.generation}`)?.({
        generation: process.generation,
        ...event
      })
    }
  }
}

describe('holonomyControlCore', () => {
  it('rejects sensitive and oversized network rules before process or adapter admission', async () => {
    const test = await createHarness()
    const input = {
      deviceId: 'android:emulator-5554',
      entryUrl: 'app+local://workspace/entry.mjs',
      inspectorMode: 'off',
      isolation: 'runtime',
      launch: { modules: [] },
      target: 'android'
    }
    try {
      await assert.rejects(
        test.core.startProcess({
          ...input,
          initialNetworkRuleSet: {
            mode: 'failClosed',
            rules: [{
              action: { status: 200, type: 'respond' },
              id: 'secret',
              match: {
                headers: { entries: [['authorization', 'Bearer secret']], mode: 'subset' }
              },
              priority: 1
            }]
          }
        }, 'sensitive-initial'),
        error => error.code === 'service.invalid_request'
      )
      await assert.rejects(
        test.core.startProcess({
          ...input,
          initialNetworkRuleSet: {
            mode: 'passthrough',
            rules: Array.from({ length: 256 }, (_, index) => ({
              action: { body: { kind: 'utf8', value: 'x'.repeat(4_096) }, status: 200, type: 'respond' },
              id: `large-${index}`,
              match: {},
              priority: index
            }))
          }
        }, 'oversized-initial'),
        error => error.code === 'service.limit_exceeded'
      )
      assert.equal(test.core.list('processes').length, 0)
      assert.equal(test.calls.length, 0)
    } finally {
      await test.close()
    }
  })

  it('binds inspector, network rules and logs to the current process generation', async () => {
    const test = await createHarness()
    try {
      const started = await test.core.startProcess({
        deviceId: 'android:emulator-5554',
        entryUrl: 'app+local://workspace/entry.mjs',
        inspectorMode: 'enabled',
        isolation: 'runtime',
        launch: { modules: [] },
        sandboxPolicy: restrictedSandboxPolicy(),
        target: 'android'
      }, 'capability-start')
      const startOperation = await waitForOperation(test.core, started.value.operation.id)
      assert.equal(
        startOperation.state,
        'succeeded',
        JSON.stringify({
          calls: test.calls,
          error: startOperation.error,
          process: test.core.get('processes', started.value.process.id, 'Runtime process')
        })
      )
      const process = test.core.get('processes', started.value.process.id, 'Runtime process')
      const inspector = await test.core.openInspector(process.id, process.generation, {}, 'inspector-key')
      const rules = await test.core.replaceNetworkRules(
        process.id,
        process.generation,
        {
          mode: 'passthrough',
          rules: [{
            action: { status: 200, type: 'respond' },
            id: 'profile',
            match: { method: 'GET', path: { op: 'exact', value: '/profile' } },
            priority: 1
          }]
        },
        '0',
        'rules-key'
      )
      assert.equal((await waitForOperation(test.core, inspector.value.operation.id)).state, 'succeeded')
      assert.equal((await waitForOperation(test.core, rules.value.operation.id)).state, 'succeeded')
      assert.equal(test.core.get('inspectors', inspector.value.inspector.id, 'Inspector lease').state, 'ready')
      assert.equal(test.core.get('networkRules', rules.value.networkRules.id, 'Network rules').state, 'active')
      const removedRules = await test.core.removeProcessNetworkRules(
        process.id,
        process.generation,
        '1',
        'rules-remove'
      )
      assert.equal((await waitForOperation(test.core, removedRules.value.operation.id)).state, 'succeeded')
      assert.equal(removedRules.value.networkRules.ruleRevision, '2')
      const replacedRules = await test.core.replaceNetworkRules(
        process.id,
        process.generation,
        { mode: 'passthrough', rules: [] },
        '2',
        'rules-replace-again'
      )
      assert.equal((await waitForOperation(test.core, replacedRules.value.operation.id)).state, 'succeeded')
      assert.equal(replacedRules.value.networkRules.ruleRevision, '3')
      assert.deepEqual(test.calls.filter(call => call.includes('rules:')), [
        'rules:1',
        'remove-rules:2',
        'rules:3'
      ])
      assert.deepEqual(await test.core.readLogs(process.id, { after: 0, waitMs: 500 }), {
        cursor: 1,
        events: [{ chunk: 'ready', generation: 1, sequence: 1, sourceSequence: 1, stream: 'stdout' }]
      })
      const events = await test.core.readEvents(0)
      const output = events.find(event => event.type === 'process.output' && event.subject === process.id)
      assert.deepEqual(output.data, {
        count: 1,
        generation: 1,
        logCursor: 1,
        processId: process.id,
        sourceCursor: 1,
        streams: ['stdout']
      })
      assert.equal((await test.core.readEvents(output.cursor)).some(event => event.cursor <= output.cursor), false)
    } finally {
      await test.close()
    }
  })

  it('generation-fences adapter terminal state and removes only retained terminal processes', async () => {
    const test = await createHarness()
    try {
      const started = await test.core.startProcess({
        deviceId: 'android:emulator-5554',
        entryUrl: 'app+local://workspace/entry.mjs',
        inspectorMode: 'off',
        isolation: 'runtime',
        launch: { modules: [] },
        target: 'android'
      }, 'terminal-start')
      await waitForOperation(test.core, started.value.operation.id)
      const process = test.core.get('processes', started.value.process.id, 'Runtime process')
      await assert.rejects(
        test.core.removeProcess(process.id, process.generation, 'active-remove'),
        error => error.code === 'service.conflict'
      )
      test.terminal(process, { exit: { code: 0, reason: 'completed' }, state: 'exited' })
      for (let turn = 0; turn < 2_000; turn += 1) {
        if (test.core.get('processes', process.id, 'Runtime process').state === 'exited') break
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      assert.deepEqual(test.core.get('processes', process.id, 'Runtime process').exit, {
        code: 0,
        reason: 'completed'
      })
      const removed = await test.core.removeProcess(process.id, process.generation, 'terminal-remove')
      assert.equal(removed.process.id, process.id)
      assert.deepEqual(removed.removed, {
        idempotency: 1,
        inspectors: 0,
        networkRules: 0,
        operations: 1,
        process: 1
      })
      assert.equal(typeof removed.removedAt, 'number')
      assert.equal(test.core.list('processes').length, 0)
      assert.ok(test.calls.includes('remove:1'))
    } finally {
      await test.close()
    }
  })

  it('defers per-device process capacity to the target adapter', async () => {
    const test = await createHarness()
    try {
      const input = {
        deviceId: 'android:emulator-5554',
        entryUrl: 'app+local://workspace/entry.mjs',
        inspectorMode: 'off',
        isolation: 'runtime',
        launch: { modules: [] },
        target: 'android'
      }
      const first = await test.core.startProcess(input, 'parallel-first')
      const second = await test.core.startProcess(input, 'parallel-second')
      await waitForOperation(test.core, first.value.operation.id)
      await waitForOperation(test.core, second.value.operation.id)
      assert.notEqual(first.value.process.id, second.value.process.id)
      assert.equal(test.core.list('processes').filter(process => process.state === 'running').length, 2)
    } finally {
      await test.close()
    }
  })

  it('persists deferred Android cleanup across daemon restarts until the device is online', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-reconcile-'))
    const initialStore = new AtomicServiceStateStore({ directory })
    await initialStore.open()
    const registry = new ControlRegistry(initialStore)
    await registry.refreshDevices([{
      id: 'android:emulator-5554',
      kind: 'emulator',
      platform: 'android',
      serial: 'emulator-5554',
      state: 'online'
    }])
    const admitted = await registry.admitProcessStart({
      deviceId: 'android:emulator-5554',
      entryUrl: 'app+local://workspace/entry.mjs',
      inspectorMode: 'off',
      isolation: 'runtime',
      launch: { env: { HOLONOMY_FIXTURE_URL: 'http://127.0.0.1:43123' }, modules: [] },
      target: 'android'
    }, 'persisted-runtime')
    const process = admitted.value.process
    await registry.updateProcess(process.id, process.generation, { state: 'staging' })
    await registry.updateProcess(process.id, process.generation, { state: 'starting' })
    await registry.updateProcess(process.id, process.generation, { state: 'running' })
    const commands = []
    const cleaned = []
    let online = false
    const commandPort = {
      close: async () => undefined,
      command: async (_serial, command) => {
        commands.push(command)
        if (!online) throw Object.assign(new Error('offline'), { code: 'service.unavailable' })
        if (command.command === 'status') return { ack: { accepted: true, generation: 7 }, state: { phase: 'running' } }
        if (command.command === 'stop') return { ack: { accepted: true, generation: 8 }, state: { phase: 'stopped' } }
        return { ack: { accepted: true, generation: 8 }, state: { phase: 'disposed' } }
      },
      cleanupProcess: async (processId, generation) => cleaned.push(`${processId}:${generation}`),
      listDevices: async () => [
        {
          id: 'android:emulator-5554',
          kind: 'emulator',
          platform: 'android',
          serial: 'emulator-5554',
          state: online ? 'online' : 'offline'
        }
      ],
      removeReverse: async () => undefined
    }
    const openCore = async () => {
      const adapter = createAndroidRuntimeAdapter({
        commandPort,
        emulatorManager: { close: async () => undefined, listEmulators: async () => [] }
      })
      const core = new HolonomyControlCore({
        adbPort: adapter,
        logStore: new ServiceLogStore({ directory: join(directory, 'logs') }),
        store: new AtomicServiceStateStore({ directory })
      })
      await core.open()
      return core
    }
    try {
      const first = await openCore()
      assert.equal(first.get('processes', process.id, 'Runtime process').state, 'lost')
      assert.equal(first.get('processes', process.id, 'Runtime process').cleanupPending, true)
      await first.close()

      const second = await openCore()
      assert.equal(second.get('processes', process.id, 'Runtime process').cleanupPending, true)
      await second.close()

      online = true
      const core = await openCore()
      assert.deepEqual(commands.map(command => [command.command, command.expectedGeneration]), [
        ['status', null],
        ['status', null],
        ['status', null],
        ['stop', 7],
        ['dispose', 8]
      ])
      assert.deepEqual(cleaned, [`${process.id}:1`])
      assert.equal(core.get('processes', process.id, 'Runtime process').state, 'lost')
      assert.equal(core.get('processes', process.id, 'Runtime process').cleanupPending, undefined)
      await core.close()
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('marks a running generation lost after bounded output transport failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-output-failure-'))
    let stopCalls = 0
    const core = new HolonomyControlCore({
      adbPort: createAdbPort({
        listDevices: async () => [{
          id: 'android:emulator-5554',
          kind: 'emulator',
          serial: 'emulator-5554',
          state: 'online'
        }],
        readLogs: async () => {
          throw new Error('transport failed')
        },
        startProcess: async () => ({}),
        stopProcess: async () => stopCalls += 1,
        subscribeProcess: () => () => undefined
      }),
      logStore: new ServiceLogStore({ directory: join(directory, 'logs') }),
      outputPollIntervalMs: 1,
      store: new AtomicServiceStateStore({ directory })
    })
    try {
      await core.open()
      await core.refreshDevices()
      const admitted = await core.startProcess({
        deviceId: 'android:emulator-5554',
        entryUrl: 'app+local://workspace/entry.mjs',
        inspectorMode: 'off',
        isolation: 'runtime',
        launch: { modules: [] },
        target: 'android'
      }, 'output-failure')
      await waitForOperation(core, admitted.value.operation.id)
      let current
      for (let turn = 0; turn < 1_000; turn += 1) {
        current = core.get('processes', admitted.value.process.id, 'Runtime process')
        if (current.state === 'lost') break
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      assert.equal(current.state, 'lost')
      assert.deepEqual(current.exit, { code: 1, reason: 'output_unavailable' })
      assert.equal(stopCalls, 1)
    } finally {
      await core.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('preserves the stable isolation unsupported code at the operation boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-isolation-'))
    const core = new HolonomyControlCore({
      adbPort: createAdbPort({
        listDevices: async () => [{
          id: 'android:emulator-5554',
          kind: 'emulator',
          serial: 'emulator-5554',
          state: 'online'
        }],
        startProcess: async () => {
          throw serviceError('process.isolation_unsupported', 'unsupported')
        }
      }),
      logStore: new ServiceLogStore({ directory: join(directory, 'logs') }),
      store: new AtomicServiceStateStore({ directory })
    })
    try {
      await core.open()
      await core.refreshDevices()
      const admitted = await core.startProcess({
        deviceId: 'android:emulator-5554',
        entryUrl: 'app+local://workspace/entry.mjs',
        inspectorMode: 'off',
        isolation: 'isolatedProcess',
        launch: { modules: [] },
        target: 'android'
      }, 'unsupported-isolation')
      const operation = await waitForOperation(core, admitted.value.operation.id)
      assert.deepEqual(operation.error, { code: 'process.isolation_unsupported', retryable: false })
    } finally {
      await core.close()
      await rm(directory, { force: true, recursive: true })
    }
  })
})
