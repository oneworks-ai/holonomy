import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { createProcessEventSinkV1 } from '@holonomyjs/capability-process/host/resource-events'
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

test('bounds zero-byte fragments while reserving error and close delivery', async () => {
  const channel = new ProcessEventChannelV1(256 * 1024)
  for (let index = 0; index < 4094; index++) {
    assert.equal(channel.emit({ event: 'data', tuple: [index] }, 0), true)
  }
  assert.equal(channel.emit({ event: 'data', tuple: ['extra'] }, 0), false)
  channel.fail({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
  const delivered = []
  channel.subscribe(envelope => delivered.push(envelope.value.event))
  await Promise.resolve()
  assert.equal(delivered.length, 4096)
  assert.deepEqual(delivered.slice(-2), ['error', 'close'])
})

test('duplicate errors cannot consume the close terminal slot', async () => {
  const channel = new ProcessEventChannelV1(256 * 1024)
  for (let index = 0; index < 4094; index++) assert.equal(channel.emit({ event: 'data' }, 1), true)
  assert.equal(channel.emit({ event: 'error' }), true)
  assert.equal(channel.emit({ event: 'error' }), false)
  assert.equal(channel.emit({ event: 'close' }), true)
  const delivered = []
  channel.subscribe(envelope => delivered.push(envelope.value.event))
  await Promise.resolve()
  assert.deepEqual(delivered.slice(-2), ['error', 'close'])
})

test('rejects an over-limit output block before Host encoding or hashing', async () => {
  let described = 0
  let killed = 0
  const stdoutEvents = new ProcessEventChannelV1(1024)
  const childEvents = new ProcessEventChannelV1(1024)
  const state = { closed: false, outputFailed: false, stdoutEvents, childEvents }
  const sink = createProcessEventSinkV1(
    state,
    () => {},
    {
      describeOutput() {
        described += 1
        throw new Error('should not encode oversized bytes')
      }
    },
    () => {
      killed += 1
    }
  )
  sink.stdout(new Uint8Array(16 * 1024 * 1024))
  assert.equal(described, 0)
  assert.equal(killed, 1)
  assert.equal(state.outputFailed, true)
  const delivered = []
  stdoutEvents.subscribe(envelope => delivered.push(envelope.value.event))
  await Promise.resolve()
  assert.deepEqual(delivered, ['error', 'close'])
})
