import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { createAdbPort } from '../adb-port.mjs'
import { HolonomyControlCore } from '../control-core.mjs'
import { ConformanceFixtureManager } from '../fixture-manager.mjs'
import { ServiceLogStore } from '../service-log-store.mjs'
import { AtomicServiceStateStore } from '../state-store.mjs'
import { restrictedSandboxPolicy } from './sandbox-fixture.mjs'

const waitForOperation = async (core, id) => {
  for (let turn = 0; turn < 2_000; turn += 1) {
    const operation = core.get('operations', id, 'Operation')
    if (['failed', 'succeeded'].includes(operation.state)) return operation
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('Sandbox process operation did not settle')
}

const waitForProcessState = async (core, id, state) => {
  for (let turn = 0; turn < 2_000; turn += 1) {
    const process = core.get('processes', id, 'Runtime process')
    if (process.state === state) return process
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error(`Sandbox process did not enter ${state}`)
}

const processInput = () => ({
  deviceId: 'android:emulator-5554',
  entryUrl: 'app+local://workspace/entry.mjs',
  fixture: { kind: 'conformance-network-v1' },
  inspectorMode: 'off',
  isolation: 'runtime',
  launch: { env: {}, modules: [] },
  sandboxPolicy: restrictedSandboxPolicy(['http://conformance.invalid'], {
    allowedSchemes: ['http'],
    allowPrivateNetwork: true
  }),
  target: 'android'
})

const deniedProcessInput = () => ({
  deviceId: 'android:emulator-5554',
  entryUrl: 'app+local://workspace/entry.mjs',
  inspectorMode: 'enabled',
  isolation: 'runtime',
  launch: { modules: [{ source: 'export {}', url: 'app+local://workspace/entry.mjs' }] },
  target: 'android'
})

const createHarness = async (options = {}) => {
  const ownsDirectory = options.directory == null
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'holonomy-sandbox-process-'))
  const lifecycleCalls = []
  const startInputs = []
  const terminalListeners = new Map()
  const adapter = createAdbPort({
    exposeFixture: async input => input.baseUrl,
    listDevices: async () => [{
      id: 'android:emulator-5554',
      kind: 'emulator',
      serial: 'emulator-5554',
      state: 'online'
    }],
    readLogs: options.readLogs ?? (async input => ({ cursor: input.after, events: [] })),
    removeProcess: async input => lifecycleCalls.push(`remove:${input.process.generation}`),
    startProcess: async input => {
      lifecycleCalls.push(`start:${input.process.generation}`)
      startInputs.push(input)
      if (options.startProcess != null) return await options.startProcess(input)
      return {}
    },
    stopProcess: async input => lifecycleCalls.push(`stop:${input.process.generation}`),
    subscribeProcess: ({ onTerminal, process }) => {
      const key = `${process.id}:${process.generation}`
      terminalListeners.set(key, onTerminal)
      return () => terminalListeners.delete(key)
    }
  })
  const core = new HolonomyControlCore({
    adbPort: adapter,
    fixtureManager: options.fixtureManager,
    logStore: new ServiceLogStore({ directory: join(directory, 'logs') }),
    now: options.now,
    retentionMs: options.retentionMs,
    store: new AtomicServiceStateStore({ directory, now: options.now, retentionMs: options.retentionMs })
  })
  await core.open()
  await core.refreshDevices()
  return {
    close: async () => {
      await core.close()
      if (ownsDirectory) await rm(directory, { force: true, recursive: true })
    },
    core,
    lifecycleCalls,
    startInputs,
    terminal(process, state) {
      terminalListeners.get(`${process.id}:${process.generation}`)?.({
        exit: { code: state === 'exited' ? 0 : 1, reason: state },
        generation: process.generation,
        state
      })
    }
  }
}

describe('service sandbox process staging', () => {
  it('owns default-deny idempotency and derives a new principal without changing policy on restart', async () => {
    const test = await createHarness()
    try {
      const input = deniedProcessInput()
      const admitted = await test.core.startProcess(input, 'start-key')
      const replayed = await test.core.startProcess(input, 'start-key')
      assert.equal(admitted.replayed, false)
      assert.equal(replayed.replayed, true)
      assert.equal(replayed.value.process.id, admitted.value.process.id)
      assert.equal((await waitForOperation(test.core, admitted.value.operation.id)).state, 'succeeded')
      const first = test.core.get('processes', admitted.value.process.id, 'Runtime process')
      assert.deepEqual(first.sandboxPolicy, {
        filesystem: { access: 'none' },
        network: { access: 'none' },
        schemaVersion: 1
      })
      assert.equal(first.sandboxPolicyDigest, '5e2ed175d63c0700bea4c6a2ec58882be4bf0e9a9f2e5499863f443a54b2b7ee')
      assert.equal(test.startInputs[0].sandboxPlan.access, 'none')
      assert.equal(test.startInputs[0].sandboxPlan.principal, `holonomy:${first.id}:android:1`)
      await assert.rejects(
        test.core.stopProcess(first.id, 2, 'stale-stop'),
        error => error.code === 'service.precondition_failed'
      )

      const restart = await test.core.restartProcess(first.id, 1, 'restart-key')
      assert.equal((await waitForOperation(test.core, restart.value.operation.id)).state, 'succeeded')
      const restarted = test.core.get('processes', first.id, 'Runtime process')
      assert.equal(restarted.generation, 2)
      assert.equal(restarted.sandboxPolicyDigest, first.sandboxPolicyDigest)
      assert.equal(test.startInputs[1].sandboxPlan.principal, `holonomy:${first.id}:android:2`)
      assert.deepEqual(test.lifecycleCalls, ['start:1', 'stop:1', 'start:2'])
    } finally {
      await test.close()
    }
  })

  it('finalizes one effective fixture policy before fake Android start and reuses it on restart', async () => {
    const test = await createHarness()
    try {
      const admitted = await test.core.startProcess(processInput(), 'fixture-start')
      assert.equal(admitted.value.process.sandboxPolicyFinalizedGeneration, undefined)
      assert.equal((await waitForOperation(test.core, admitted.value.operation.id)).state, 'succeeded')
      const first = test.core.get('processes', admitted.value.process.id, 'Runtime process')
      assert.equal(first.sandboxPolicyFinalizedGeneration, 1)
      assert.ok(first.sandboxPolicy.network.allowedOrigins.includes(new URL(first.fixtureRuntimeUrl).origin))
      assert.deepEqual(test.startInputs[0].process.sandboxPolicy, first.sandboxPolicy)
      assert.equal(test.startInputs[0].sandboxPlan.policyDigest, first.sandboxPolicyDigest)
      assert.equal(test.startInputs[0].process.launch.env.HOLONOMY_FIXTURE_URL, first.fixtureRuntimeUrl)

      const restart = await test.core.restartProcess(first.id, first.generation, 'fixture-restart')
      assert.equal((await waitForOperation(test.core, restart.value.operation.id)).state, 'succeeded')
      const restarted = test.core.get('processes', first.id, 'Runtime process')
      assert.equal(restarted.generation, 2)
      assert.equal(restarted.fixtureRuntimeUrl, first.fixtureRuntimeUrl)
      assert.equal(restarted.sandboxPolicyDigest, first.sandboxPolicyDigest)
      assert.deepEqual(restarted.sandboxPolicy, first.sandboxPolicy)
      assert.equal(test.startInputs[1].process.launch.env.HOLONOMY_FIXTURE_URL, first.fixtureRuntimeUrl)
    } finally {
      await test.close()
    }
  })

  it('retains a finalized fixture after adapter failure so the failed process can restart', async () => {
    const stopped = []
    let attempts = 0
    const fixtureManager = {
      close: async () => undefined,
      start: async process => ({
        baseUrl: 'http://127.0.0.1:48123',
        descriptor: process.fixture,
        generation: process.generation,
        processId: process.id
      }),
      stop: async (processId, generation) => {
        stopped.push(`${processId}:${generation}`)
        return true
      }
    }
    const test = await createHarness({
      fixtureManager,
      readLogs: async input =>
        input.after === 0
          ? {
            cursor: 1,
            events: [{ chunk: 'Node Runtime start failed: entry_evaluation', sequence: 1, stream: 'error' }]
          }
          : { cursor: input.after, events: [] },
      startProcess: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('adapter failed after staging')
        return {}
      }
    })
    try {
      const admitted = await test.core.startProcess(processInput(), 'fixture-failure')
      const failedOperation = await waitForOperation(test.core, admitted.value.operation.id)
      assert.equal(failedOperation.state, 'failed')
      assert.deepEqual(failedOperation.error, { code: 'service.unavailable', retryable: true })
      assert.deepEqual(await test.core.readLogs(admitted.value.process.id), {
        cursor: 1,
        events: [{
          chunk: 'Node Runtime start failed: entry_evaluation',
          generation: 1,
          sequence: 1,
          sourceSequence: 1,
          stream: 'error'
        }]
      })
      assert.deepEqual(stopped, [])
      const failed = test.core.get('processes', admitted.value.process.id, 'Runtime process')
      const restart = await test.core.restartProcess(failed.id, failed.generation, 'fixture-failure-restart')
      assert.equal((await waitForOperation(test.core, restart.value.operation.id)).state, 'succeeded')
      const restarted = test.core.get('processes', failed.id, 'Runtime process')
      assert.equal(restarted.fixtureRuntimeUrl, failed.fixtureRuntimeUrl)
      assert.equal(restarted.sandboxPolicyDigest, failed.sandboxPolicyDigest)
      assert.deepEqual(stopped, [])
    } finally {
      await test.close()
    }
  })

  it('retains one process fixture through exited and failed generations until explicit removal', async () => {
    const test = await createHarness()
    try {
      const admitted = await test.core.startProcess(processInput(), 'terminal-fixture-start')
      assert.equal((await waitForOperation(test.core, admitted.value.operation.id)).state, 'succeeded')
      const first = test.core.get('processes', admitted.value.process.id, 'Runtime process')
      const fixtureUrl = first.fixtureRuntimeUrl

      test.terminal(first, 'exited')
      const exited = await waitForProcessState(test.core, first.id, 'exited')
      assert.equal((await fetch(`${fixtureUrl}/profile`)).status, 200)
      const firstRestart = await test.core.restartProcess(exited.id, exited.generation, 'restart-exited')
      assert.equal((await waitForOperation(test.core, firstRestart.value.operation.id)).state, 'succeeded')
      const second = test.core.get('processes', first.id, 'Runtime process')
      assert.equal(second.fixtureRuntimeUrl, fixtureUrl)

      test.terminal(second, 'failed')
      const failed = await waitForProcessState(test.core, second.id, 'failed')
      const secondRestart = await test.core.restartProcess(failed.id, failed.generation, 'restart-failed')
      assert.equal((await waitForOperation(test.core, secondRestart.value.operation.id)).state, 'succeeded')
      const third = test.core.get('processes', first.id, 'Runtime process')
      assert.equal(third.fixtureRuntimeUrl, fixtureUrl)
      assert.equal(third.sandboxPolicyDigest, first.sandboxPolicyDigest)

      test.terminal(third, 'exited')
      const terminal = await waitForProcessState(test.core, third.id, 'exited')
      await test.core.removeProcess(terminal.id, terminal.generation, 'remove-fixture-process')
      await assert.rejects(fetch(`${fixtureUrl}/profile`))
    } finally {
      await test.close()
    }
  })

  it('releases retained fixtures when terminal process retention expires', async () => {
    let now = 1_000
    const released = []
    const fixtures = new ConformanceFixtureManager({
      startFixture: async () => ({
        close: async () => released.push('closed'),
        url: 'http://127.0.0.1:48124'
      })
    })
    const test = await createHarness({ fixtureManager: fixtures, now: () => now, retentionMs: 100 })
    try {
      const admitted = await test.core.startProcess(processInput(), 'retained-fixture-start')
      await waitForOperation(test.core, admitted.value.operation.id)
      const process = test.core.get('processes', admitted.value.process.id, 'Runtime process')
      test.terminal(process, 'exited')
      await waitForProcessState(test.core, process.id, 'exited')
      assert.deepEqual(released, [])
      now += 101
      const result = await test.core.pruneRetention()
      assert.equal(result.resources.processes, 1)
      assert.deepEqual(released, ['closed'])
    } finally {
      await test.close()
    }
  })

  it('rebinds the persisted fixture before adapter start after an empty-manager daemon recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-sandbox-recovery-'))
    const first = await createHarness({ directory })
    let firstProcess
    try {
      const admitted = await first.core.startProcess(processInput(), 'daemon-fixture-start')
      await waitForOperation(first.core, admitted.value.operation.id)
      firstProcess = first.core.get('processes', admitted.value.process.id, 'Runtime process')
      first.terminal(firstProcess, 'exited')
      await waitForProcessState(first.core, firstProcess.id, 'exited')
    } finally {
      await first.close()
    }

    const recovered = await createHarness({ directory })
    try {
      const restart = await recovered.core.restartProcess(
        firstProcess.id,
        firstProcess.generation,
        'daemon-fixture-restart'
      )
      assert.equal((await waitForOperation(recovered.core, restart.value.operation.id)).state, 'succeeded')
      const process = recovered.core.get('processes', firstProcess.id, 'Runtime process')
      assert.equal(process.fixtureRuntimeUrl, firstProcess.fixtureRuntimeUrl)
      assert.equal(process.sandboxPolicyDigest, firstProcess.sandboxPolicyDigest)
      assert.equal(recovered.startInputs[0].process.launch.env.HOLONOMY_FIXTURE_URL, firstProcess.fixtureRuntimeUrl)
    } finally {
      await recovered.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('does not start an adapter when exact fixture recovery fails', async () => {
    const fixtureError = Object.assign(new Error('port occupied'), { code: 'EADDRINUSE' })
    const test = await createHarness({
      fixtureManager: {
        close: async () => undefined,
        start: async () => {
          throw fixtureError
        },
        stop: async () => false
      }
    })
    try {
      const admitted = await test.core.startProcess(processInput(), 'fixture-bind-conflict')
      const operation = await waitForOperation(test.core, admitted.value.operation.id)
      assert.equal(operation.state, 'failed')
      assert.deepEqual(test.startInputs, [])
    } finally {
      await test.close()
    }
  })
})
