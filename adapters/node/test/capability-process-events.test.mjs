import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { ProcessEventChannelV1 } from '../src/capability-process-events.mjs'

test('pauses Guest delivery while Host accounting and terminal events continue', async () => {
  const channel = new ProcessEventChannelV1(2)
  const delivered = []
  channel.subscribe(envelope => {
    delivered.push(envelope.value.event)
    if (envelope.value.event === 'first') channel.pause()
  })

  assert.equal(channel.emit({ event: 'first', tuple: [] }, 1), true)
  assert.equal(channel.emit({ event: 'second', tuple: [] }, 1), true)
  assert.equal(channel.emit({ event: 'overflow', tuple: [] }, 1), false)
  assert.deepEqual(delivered, ['first'])
  channel.fail({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
  await Promise.resolve()
  assert.deepEqual(delivered, ['first', 'second', 'error', 'close'])

  channel.resume()
  assert.deepEqual(delivered, ['first', 'second', 'error', 'close'])
})
