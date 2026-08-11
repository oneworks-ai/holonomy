import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { ServiceLogStore } from '../service-log-store.mjs'

const withTemporaryDirectory = async callback => {
  const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-logs-'))
  try {
    return await callback(directory)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

const log = (generation, chunk, sequence) => ({
  chunk,
  generation,
  sequence,
  stream: 'stdout'
})

describe('service log store', () => {
  it('keeps Service cursors continuous across generations and daemon reopen', async () => {
    await withTemporaryDirectory(async directory => {
      let now = 1_000
      const store = await ServiceLogStore.open({ directory, now: () => now })

      assert.deepEqual(await store.append('process-a', log(1, 'first', 41)), {
        chunk: 'first',
        generation: 1,
        sequence: 1,
        sourceSequence: 41,
        stream: 'stdout'
      })
      now += 1
      await store.append('process-a', log(2, 'second', 1))
      await store.append('process-a', { chunk: 'without source cursor', generation: 2, stream: 'stderr' })
      assert.deepEqual(store.page('process-a', { after: 0, generation: 2 }), {
        cursor: 3,
        events: [
          { chunk: 'second', generation: 2, sequence: 2, sourceSequence: 1, stream: 'stdout' },
          { chunk: 'without source cursor', generation: 2, sequence: 3, stream: 'stderr' }
        ]
      })
      await store.close()

      const reopened = await ServiceLogStore.open({ directory, now: () => now })
      assert.deepEqual(reopened.page('process-a', { after: 0 }).events.map(event => event.sequence), [1, 2, 3])
      assert.equal((await reopened.append('process-a', log(3, 'third', 1))).sequence, 4)
      await reopened.close()
    })
  })

  it('enforces per-process and global caps and preserves expired cursor floors on reopen', async () => {
    await withTemporaryDirectory(async directory => {
      let now = 10_000
      const options = {
        directory,
        maxEntriesPerProcess: 2,
        maxProcessBytes: 4_096,
        maxTotalBytes: 8_192,
        maxTotalEntries: 3,
        now: () => now,
        ttlMs: 100
      }
      const store = await ServiceLogStore.open(options)
      await store.append('process-a', [log(1, 'a1', 1), log(1, 'a2', 2), log(1, 'a3', 3)])
      await assert.rejects(
        async () => store.page('process-a', { after: 0 }),
        error => error.code === 'service.cursor_expired' && error.details.earliestCursor === 2
      )
      assert.deepEqual(store.page('process-a', { after: 1 }).events.map(event => event.chunk), ['a2', 'a3'])

      now += 1
      await store.append('process-b', [log(1, 'b1', 1), log(1, 'b2', 2)])
      await assert.rejects(
        async () => store.page('process-a', { after: 1 }),
        error => error.code === 'service.cursor_expired' && error.details.earliestCursor === 3
      )
      assert.deepEqual(store.page('process-a', { after: 2 }).events.map(event => event.chunk), ['a3'])
      assert.deepEqual(store.page('process-b', { after: 0 }).events.map(event => event.chunk), ['b1', 'b2'])

      now += 101
      assert.equal(await store.prune(), 3)
      await store.close()
      const reopened = await ServiceLogStore.open(options)
      await assert.rejects(
        async () => reopened.page('process-b', { after: 0 }),
        error => error.code === 'service.cursor_expired' && error.details.earliestCursor === 3
      )
      assert.equal(await reopened.remove('process-b'), true)
      assert.deepEqual(reopened.page('process-b', { after: 0 }), { cursor: 0, events: [] })
      await reopened.close()
    })
  })

  it('serializes concurrent appends and rejects oversized entries with stable redacted errors', async () => {
    await withTemporaryDirectory(async directory => {
      const store = await ServiceLogStore.open({
        directory,
        maxProcessBytes: 256,
        maxTotalBytes: 512,
        now: () => 1
      })
      const appended = await Promise.all(Array.from({ length: 8 }, (_, index) => (
        store.append('process-a', log(1, String(index), index))
      )))
      assert.deepEqual(appended.map(event => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8])
      await assert.rejects(
        store.append('process-a', log(1, 'x'.repeat(1_024), 9)),
        error => error.code === 'service.limit_exceeded' && !error.message.includes(directory)
      )
      await store.close()
    })
  })

  it('reports corrupt persisted state without exposing its filesystem path', async () => {
    await withTemporaryDirectory(async directory => {
      await writeFile(join(directory, `${'0'.repeat(64)}.json`), '{truncated', 'utf8')
      await assert.rejects(
        ServiceLogStore.open({ directory }),
        error => error.code === 'service.state_corrupt' && !error.message.includes(directory)
      )
    })
  })
})
