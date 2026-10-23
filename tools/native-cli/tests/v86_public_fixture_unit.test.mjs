/* eslint-disable test/no-import-node-test -- Tests the external fixture lifecycle, not Guest behavior. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { observeNativeFixtureChildClose, stopNativeFixtureChildren } from './v86_public_child.mjs'

test('an error is recorded but cannot stand in for actual child close', async () => {
  const child = new EventEmitter()
  const observed = observeNativeFixtureChildClose(child)
  let settled = false
  void observed.closed.then(() => settled = true)
  const failure = new Error('owned child failed')
  child.emit('error', failure)
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(observed.didClose, false)
  assert.equal(observed.error, failure)
  child.emit('close', 1, null)
  assert.deepEqual(await observed.closed, [1, null])
  assert.equal(observed.didClose, true)
})

test('duplicate close cannot replace the selected terminal', async () => {
  const child = new EventEmitter()
  const observed = observeNativeFixtureChildClose(child)
  child.emit('close', null, 'SIGTERM')
  child.emit('close', 0, null)
  assert.deepEqual(await observed.closed, [null, 'SIGTERM'])
})

test('late child errors are consumed without erasing the first error or close', async () => {
  const child = new EventEmitter()
  const observed = observeNativeFixtureChildClose(child)
  const first = new Error('first')
  child.emit('error', first)
  child.emit('close', 1, null)
  child.emit('error', new Error('late'))
  assert.equal(observed.error, first)
  assert.deepEqual(await observed.closed, [1, null])
})

test('cleanup allows the CLI grace then fails finitely when inherited pipes never close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signals = []
  let destroyed = 0
  const child = Object.assign(new EventEmitter(), {
    kill: signal => {
      signals.push(signal)
      return false
    },
    stdout: { destroy: () => destroyed++ },
    stderr: { destroy: () => destroyed++ }
  })
  const observed = observeNativeFixtureChildClose(child)
  const result = stopNativeFixtureChildren([[child, observed.closed]])
    .then(() => ({ ok: true }), error => ({ error }))
  child.emit('error', new Error('parent already exited'))
  assert.deepEqual(signals, ['SIGTERM'])
  t.mock.timers.tick(2500)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(observed.didClose, false)
  t.mock.timers.tick(1000)
  const terminal = await result
  assert.equal(terminal.ok, undefined)
  assert.match(terminal.error.message, /did not settle before its deadline/u)
  assert.equal(destroyed, 2)
  child.emit('close', 1, null)
  await observed.closed
})
