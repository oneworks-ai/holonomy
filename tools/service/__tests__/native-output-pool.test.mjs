import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { describe, it } from 'vitest'
import { NativeOutputPool } from '../native-output-pool.mjs'

const record = () => ({ logs: [], nextSequence: 1 })
describe('native bounded output staging', () => {
  it('bounds each record and aggregate bytes with an explicit cursor gap', () => {
    const pool = new NativeOutputPool({ maxBytes: 4096, maxRecordBytes: 2048, maxEvents: 32, maxRecordEvents: 16 })
    const first = record()
    const second = record()
    for (let index = 0; index < 100; index++) {
      pool.append(first, 'stdout', 'a'.repeat(400))
      pool.append(second, 'stderr', 'b'.repeat(400))
      assert.ok(pool.snapshot.bytes <= 4096)
      assert.ok(first.logBytes <= 2048 && second.logBytes <= 2048)
    }
    const page = pool.page(first, 0, 256)
    assert.match(page.events[0].chunk, /Native output dropped/u)
    assert.equal(page.cursor, first.nextSequence - 1)
    pool.release(first)
    pool.release(second)
    assert.deepEqual(pool.snapshot, { bytes: 0, events: 0 })
    pool.append(first, 'stdout', 'late')
    assert.deepEqual(pool.snapshot, { bytes: 0, events: 0 })
  })

  it('bounds exact serialized pages below the output pump limit without losing cursor progress', () => {
    const pool = new NativeOutputPool()
    const process = record()
    for (let index = 0; index < 100; index++) pool.append(process, 'stdout', 'x'.repeat(16 * 1024))
    let cursor = 0
    let received = 0
    do {
      const page = pool.page(process, cursor, 256)
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 512 * 1024)
      assert.ok(page.cursor > cursor)
      received += page.events.length
      cursor = page.cursor
    } while (cursor < process.nextSequence - 1)
    assert.equal(received, 100)
    pool.release(process)
  })
})
