import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { HolonomyControlRunner } from '../control-runner.mjs'
import { ControlRegistry } from '../registry.mjs'
import { pruneRegistryRetention } from '../retention.mjs'
import { AtomicServiceStateStore } from '../state-store.mjs'

it('journals final cleanup with metadata removal and retries it after reopening the store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'holo-removal-cleanup-'))
  try {
    const store = new AtomicServiceStateStore({ directory })
    await store.open()
    await store.transact(() => ({ type: 'test.seed' }), draft => {
      draft.resources.processes.process_removed = {
        id: 'process_removed',
        generation: 1,
        target: 'native',
        state: 'exited',
        endedAt: 1
      }
      return true
    })
    await assert.rejects(pruneRegistryRetention({ store, now: () => 100, retentionMs: 1 }, {
      beforeRemoveProcess: async () => {},
      afterRemoveProcess: async () => {
        throw new Error('filesystem unavailable')
      }
    }))
    assert.equal(store.getSnapshot().resources.processes.process_removed, undefined)
    assert.equal(store.getSnapshot().pendingProcessCleanup.process_removed.generation, 1)
    const reopened = new AtomicServiceStateStore({ directory })
    await reopened.open()
    const registry = new ControlRegistry(reopened)
    let fail = true
    let calls = 0
    const runner = new HolonomyControlRunner({
      registry,
      outputPump: {},
      adapterDispatcher: {
        target: () => ({
          removeProcess: async ({ process, finalized }) => {
            assert.equal(process.id, 'process_removed')
            assert.equal(finalized, true)
            calls++
            if (fail) throw new Error('retry later')
          }
        })
      }
    })
    await runner.retryRemovalCleanups()
    assert.equal(registry.pendingRemovalCleanups().length, 1)
    fail = false
    await runner.retryRemovalCleanups()
    assert.equal(registry.pendingRemovalCleanups().length, 0)
    assert.equal(calls, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
