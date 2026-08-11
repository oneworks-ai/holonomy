import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { reconcileServiceState } from '../reconcile-service-state.mjs'
import { AtomicServiceStateStore, atomicWriteJson } from '../state-store.mjs'

const withTemporaryDirectory = async callback => {
  const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-state-'))
  try {
    return await callback(directory)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

describe('atomicServiceStateStore', () => {
  it('recovers a write-ahead journal record newer than the atomic snapshot', async () => {
    await withTemporaryDirectory(async directory => {
      let now = 1_000
      const store = new AtomicServiceStateStore({ directory, now: () => now })
      await store.open()
      await store.transact({ type: 'first' }, draft => {
        draft.resources.devices.first = { id: 'first' }
        return { admitted: 'first' }
      })
      const olderSnapshot = store.getSnapshot()
      now += 1
      await store.transact({ type: 'second' }, draft => {
        draft.resources.devices.second = { id: 'second' }
        return { admitted: 'second' }
      })

      await atomicWriteJson(join(directory, 'state.json'), olderSnapshot, 4 * 1024 * 1024)
      const recovered = new AtomicServiceStateStore({ directory, now: () => now })
      const snapshot = await recovered.open()

      assert.equal(snapshot.cursor, 2)
      assert.deepEqual(Object.keys(snapshot.resources.devices).sort(), ['first', 'second'])
      assert.equal(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).cursor, 2)
    })
  })

  it('serializes concurrent commits and expires old event cursors', async () => {
    await withTemporaryDirectory(async directory => {
      let now = 10_000
      const store = new AtomicServiceStateStore({ directory, now: () => now, retentionMs: 100 })
      await store.open()
      await Promise.all(Array.from({ length: 8 }, (_, index) => (
        store.transact({ data: { index }, type: 'concurrent' }, draft => {
          draft.resources.devices[`device-${index}`] = { id: `device-${index}` }
          return index
        })
      )))
      assert.equal(store.getSnapshot().cursor, 8)
      assert.deepEqual((await store.readEvents(0)).map(event => event.cursor), [1, 2, 3, 4, 5, 6, 7, 8])

      now += 101
      assert.equal(await store.pruneEvents(), 8)
      await assert.rejects(store.readEvents(0), error => error.code === 'service.cursor_expired')
    })
  })

  it('marks unverifiable active generations lost after daemon reopen', async () => {
    await withTemporaryDirectory(async directory => {
      const first = new AtomicServiceStateStore({ directory })
      await first.open()
      await first.transact({ type: 'process.running' }, draft => {
        draft.resources.processes.process_stale = {
          generation: 2,
          id: 'process_stale',
          revision: 1,
          state: 'running',
          updatedAt: Date.now()
        }
        return true
      })
      const reopened = new AtomicServiceStateStore({ directory })
      await reopened.open()
      assert.equal((await reconcileServiceState(reopened)).processes, 1)
      const processRecord = reopened.getSnapshot().resources.processes.process_stale
      assert.equal(processRecord.state, 'lost')
      assert.deepEqual(processRecord.exit, { reason: 'service_restart' })
      assert.equal((await reconcileServiceState(reopened)).processes, 0)
    })
  })
})
