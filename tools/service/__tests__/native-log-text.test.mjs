import assert from 'node:assert/strict'
import { it } from 'vitest'

import { nativeLogContains } from './native-log-text.mjs'

const event = (chunk, generation = 1, stream = 'stderr') => ({ chunk, generation, stream })
it('matches the actual terminal diagnostic split across Service chunks', () => {
  const marker = 'holo observer callback.failed runtime.terminated'
  const page = {
    events: [
      event('holo observer callback.failed runtime.exception\nholo observer '),
      event('callback.failed runtime.terminated\n')
    ]
  }
  assert.equal(page.events.some(row => row.chunk.includes(marker)), false)
  assert.equal(nativeLogContains(page, marker), true)
})
it('keeps interleaved stdout separate while assembling stderr', () => {
  assert.equal(nativeLogContains({ events: [event('abc'), event('other', 1, 'stdout'), event('def')] }, 'abcdef'), true)
})
it('cannot manufacture a marker by joining generations', () => {
  assert.equal(nativeLogContains({ events: [event('abc'), event('def', 2)] }, 'abcdef'), false)
})
it('cannot manufacture a marker by joining streams', () => {
  assert.equal(nativeLogContains({ events: [event('abc'), event('def', 1, 'stdout')] }, 'abcdef'), false)
})
it('restricts positive and private-marker checks to the requested generation', () => {
  const page = { events: [event('PRIVATE_'), event('SENTINEL'), event('current', 2)] }
  assert.equal(nativeLogContains(page, 'PRIVATE_SENTINEL'), true)
  assert.equal(nativeLogContains(page, 'PRIVATE_SENTINEL', 2), false)
  assert.equal(nativeLogContains(page, 'current', 2), true)
})
