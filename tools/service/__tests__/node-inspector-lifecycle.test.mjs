import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { HolonomyControlCore } from '../control-core.mjs'
import { createNodeRuntimeAdapter } from '../node-target-adapter.mjs'
import { ServiceLogStore } from '../service-log-store.mjs'
import { AtomicServiceStateStore } from '../state-store.mjs'
import { createTargetAdapterDispatcher } from '../target-adapters.mjs'

const waitForOperation = async (core, id) => {
  for (let turn = 0; turn < 2_000; turn += 1) {
    const operation = core.get('operations', id, 'Operation')
    if (['cancelled', 'failed', 'succeeded'].includes(operation.state)) return operation
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('Node inspector operation did not settle')
}

const waitForProcessState = async (core, id, state) => {
  for (let turn = 0; turn < 2_000; turn += 1) {
    const process = core.get('processes', id, 'Runtime process')
    if (process.state === state) return process
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`Node process did not enter ${state}`)
}

const waitForLog = async (core, id, after, text) => {
  let cursor = after
  for (let turn = 0; turn < 500; turn += 1) {
    const page = await core.readLogs(id, { after: cursor, waitMs: 10 })
    if (page.events.some(event => event.chunk === text)) return
    cursor = page.cursor
  }
  throw new Error(`Node process log was not observed: ${text}`)
}

describe('node inspector process lifecycle', () => {
  it('admits inspector leases before entry and resumes the exact break generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-node-inspector-'))
    const node = createNodeRuntimeAdapter({ resumeTimeoutMs: 5_000 })
    const core = new HolonomyControlCore({
      adapterDispatcher: createTargetAdapterDispatcher({ node }),
      deviceRefreshIntervalMs: 60_000,
      logStore: new ServiceLogStore({ directory: join(directory, 'logs') }),
      outputPollIntervalMs: 5,
      store: new AtomicServiceStateStore({ directory })
    })
    try {
      await core.open()
      const started = await core.startProcess({
        deviceId: 'node:local',
        entryUrl: 'app+local://debug/main.mjs',
        inspectorMode: 'break',
        isolation: 'runtime',
        launch: {
          modules: [{
            source: `console.log('SERVICE_BREAK_ENTRY'); setInterval(() => {}, 1_000)`,
            url: 'app+local://debug/main.mjs'
          }]
        },
        target: 'node'
      }, 'node-break-start')
      assert.equal((await waitForOperation(core, started.value.operation.id)).state, 'succeeded')
      let process = core.get('processes', started.value.process.id, 'Runtime process')
      assert.equal(process.state, 'waiting_for_debugger')
      const beforeResume = await core.readLogs(process.id, { after: 0 })
      assert.equal(
        beforeResume.events.some(event => event.chunk === 'SERVICE_BREAK_ENTRY'),
        false
      )

      const opened = await core.openInspector(process.id, process.generation, {}, 'node-break-inspector')
      assert.equal((await waitForOperation(core, opened.value.operation.id)).state, 'succeeded')
      assert.equal(core.get('inspectors', opened.value.inspector.id, 'Inspector lease').state, 'ready')

      const devTools = core.inspectorProxy().connect(opened.value.inspector.id, () => undefined)
      for (const id of [1, 2]) {
        assert.deepEqual(await devTools.receive({ id, method: 'Runtime.runIfWaitingForDebugger' }), {
          id,
          result: {}
        })
      }
      process = await waitForProcessState(core, process.id, 'running')
      assert.equal(core.list('operations').filter(operation => operation.kind === 'process.resume').length, 1)
      await waitForLog(core, process.id, beforeResume.cursor, 'SERVICE_BREAK_ENTRY')

      const stopped = await core.stopProcess(process.id, process.generation, 'node-break-stop')
      assert.equal((await waitForOperation(core, stopped.value.operation.id)).state, 'succeeded')

      const inspected = await core.startProcess({
        deviceId: 'node:local',
        entryUrl: 'app+local://debug/inspect.mjs',
        inspectorMode: 'enabled',
        isolation: 'runtime',
        launch: {
          modules: [{
            source: `await new Promise(resolve => setTimeout(resolve, 1_500)); console.log('SERVICE_INSPECT_ENTRY')`,
            url: 'app+local://debug/inspect.mjs'
          }]
        },
        target: 'node'
      }, 'node-inspect-start')
      assert.equal((await waitForOperation(core, inspected.value.operation.id)).state, 'succeeded')
      const inspectProcess = core.get('processes', inspected.value.process.id, 'Runtime process')
      assert.equal(inspectProcess.state, 'running')
      const inspectLease = await core.openInspector(
        inspectProcess.id,
        inspectProcess.generation,
        {},
        'node-inspect-lease'
      )
      assert.equal((await waitForOperation(core, inspectLease.value.operation.id)).state, 'succeeded')
      const beforeEntry = await core.readLogs(inspectProcess.id, { after: 0 })
      assert.equal(
        beforeEntry.events.some(event => event.chunk === 'SERVICE_INSPECT_ENTRY'),
        false
      )
      await waitForLog(core, inspectProcess.id, beforeEntry.cursor, 'SERVICE_INSPECT_ENTRY')
      const inspectStopped = await core.stopProcess(
        inspectProcess.id,
        inspectProcess.generation,
        'node-inspect-stop'
      )
      assert.equal((await waitForOperation(core, inspectStopped.value.operation.id)).state, 'succeeded')
    } finally {
      await core.close()
      await rm(directory, { force: true, recursive: true })
    }
  }, 30_000)
})
