import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { HolonomyControlCore } from '../control-core.mjs'
import { serviceError } from '../errors.mjs'
import { ServiceLogStore } from '../service-log-store.mjs'
import { AtomicServiceStateStore } from '../state-store.mjs'
import { createNativeLocalAdapter, createTargetAdapterDispatcher } from '../target-adapters.mjs'

const terminal = async (core, id) => {
  for (let turn = 0; turn < 1_000; turn++) {
    const operation = core.get('operations', id, 'Operation')
    if (['failed', 'cancelled', 'succeeded'].includes(operation.state)) return operation
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.fail('Lifecycle operation stayed nonterminal')
}

const fixture = async (methods, work) => {
  const root = await mkdtemp(join(tmpdir(), 'holo-native-resume-'))
  const core = new HolonomyControlCore({
    adapterDispatcher: createTargetAdapterDispatcher({
      native: createNativeLocalAdapter({
        close: async () => undefined,
        readLogs: async () => ({ cursor: 0, events: [] }),
        startProcess: async () => ({ waitingForDebugger: true }),
        stopProcess: async () => undefined,
        ...methods
      })
    }),
    logStore: new ServiceLogStore({ directory: join(root, 'logs') }),
    store: new AtomicServiceStateStore({ directory: root })
  })
  try {
    await core.open()
    await core.refreshDevices()
    const started = await core.startProcess({
      deviceId: 'native:local',
      entryUrl: 'app://workspace/main.mjs',
      inspectorMode: 'break',
      isolation: 'runtime',
      target: 'native',
      launch: {
        argv: ['app://workspace/main.mjs'],
        command: 'run',
        entryUrl: 'app://workspace/main.mjs',
        moduleRootUrl: 'app://workspace/',
        modules: [{ source: '', url: 'app://workspace/main.mjs' }],
        schemaVersion: 2,
        target: 'native'
      }
    }, 'start')
    assert.equal((await terminal(core, started.value.operation.id)).state, 'succeeded')
    await work(core, started.value.process.id)
  } finally {
    await core.close()
    await rm(root, { recursive: true, force: true })
  }
}

describe('native resume lifecycle ownership', () => {
  for (const failCleanup of [false, true]) {
    it(`stops an ambiguous resume before failure; cleanupPending=${failCleanup}`, async () => {
      let released = false
      let stops = 0
      await fixture({
        resumeProcess: async () => {
          released = true
          throw serviceError('service.unavailable', 'Lost resume acknowledgement')
        },
        stopProcess: async () => {
          assert.equal(released, true)
          stops++
          if (failCleanup) throw serviceError('service.unavailable', 'Cleanup still pending')
        }
      }, async (core, id) => {
        const resumed = await core.resumeProcess(id, 1, 'ambiguous')
        assert.equal((await terminal(core, resumed.value.operation.id)).state, 'failed')
        assert.equal(stops, 1)
        const process = core.get('processes', id, 'Runtime process')
        assert.equal(process.state, 'failed')
        assert.equal(process.cleanupPending === true, failCleanup)
      })
    })
  }

  for (const action of ['stop', 'restart']) {
    it(`does not let a late resume overwrite concurrent ${action}`, async () => {
      let release
      let began
      const begun = new Promise(resolve => began = resolve)
      await fixture({
        resumeProcess: async () => {
          began()
          await new Promise(resolve => release = resolve)
        }
      }, async (core, id) => {
        const resumed = await core.resumeProcess(id, 1, 'resume')
        await begun
        const next = action === 'stop'
          ? await core.stopProcess(id, 1, 'stop')
          : await core.restartProcess(id, 1, 'restart')
        release()
        assert.equal((await terminal(core, resumed.value.operation.id)).state, 'cancelled')
        assert.equal((await terminal(core, next.value.operation.id)).state, 'succeeded')
        const process = core.get('processes', id, 'Runtime process')
        assert.equal(process.state, action === 'stop' ? 'cancelled' : 'waiting_for_debugger')
        assert.equal(process.generation, action === 'stop' ? 1 : 2)
      })
    })
  }
})
