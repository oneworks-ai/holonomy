import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { describe, it } from 'vitest'

import { CdpBodyAccumulator } from '../cdp-body-accumulator.mjs'
import { CdpRequestIds } from '../cdp-session-support.mjs'

describe('bounded CDP diagnostic state', () => {
  it('bounds request identifiers and releases terminal and expired entries', () => {
    let now = 0
    const ids = new CdpRequestIds({
      maxActiveRequests: 2,
      maxActiveRequestsPerProcess: 1,
      now: () => now,
      requestTtlMs: 10
    })
    const first = ids.open('process-a:1', 'private-a')
    assert.notEqual(first, 'private-a')
    assert.throws(() => ids.open('process-a:1', 'private-b'), error => error.code === 'service.limit_exceeded')
    assert.equal(ids.close('process-a:1', 'private-a'), true)
    ids.open('process-a:1', 'private-b')
    now = 11
    assert.deepEqual(ids.snapshot(), { processes: 0, requests: 0 })
  })

  it('drops oversized body state while keeping diagnostics terminal and accounting bounded', () => {
    let now = 0
    const cached = []
    const accumulator = new CdpBodyAccumulator({ put: (...input) => cached.push(input) }, {
      maxActiveRequests: 2,
      maxActiveRequestsPerProcess: 2,
      maxProcessBodyBytes: 2,
      maxResponseBodyBytes: 2,
      maxServiceBodyBytes: 2,
      now: () => now,
      requestTtlMs: 10
    })
    assert.equal(accumulator.ingest('process-a:1', 'request-a', { type: 'requestWillBeSent' }), true)
    assert.equal(
      accumulator.ingest('process-a:1', 'request-a', {
        dataBase64: Buffer.from('abc').toString('base64'),
        type: 'dataReceived'
      }),
      true
    )
    assert.deepEqual(accumulator.snapshot(), { bytes: 0, processes: 1, requests: 1 })
    assert.equal(accumulator.ingest('process-a:1', 'request-a', { type: 'loadingFinished' }), true)
    assert.equal(cached.length, 0)
    assert.deepEqual(accumulator.snapshot(), { bytes: 0, processes: 0, requests: 0 })

    accumulator.ingest('process-a:1', 'request-b', { type: 'requestWillBeSent' })
    accumulator.ingest('process-a:1', 'request-b', {
      dataBase64: Buffer.from('ok').toString('base64'),
      type: 'dataReceived'
    })
    now = 11
    assert.deepEqual(accumulator.snapshot(), { bytes: 0, processes: 0, requests: 0 })
  })
})
