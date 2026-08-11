import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { DeviceWatcher } from '../device-watcher.mjs'

const deferred = () => {
  let reject
  let resolve
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise
    resolve = resolvePromise
  })
  return { promise, reject, resolve }
}

const device = (id, state = 'online') => ({
  id: `android:${id}`,
  kind: 'physical',
  platform: 'android',
  serial: id,
  state
})

const fakeScheduler = () => {
  let nextId = 1
  const timers = new Map()
  return {
    clearTimeout: id => timers.delete(id),
    runNext() {
      const entry = timers.entries().next().value
      assert.ok(entry)
      timers.delete(entry[0])
      entry[1]()
    },
    setTimeout(callback) {
      const id = nextId++
      timers.set(id, callback)
      return id
    },
    size: () => timers.size
  }
}

describe('device watcher', () => {
  it('normalizes hotplug states and keeps the last observedAt when a device disconnects', async () => {
    let now = 100
    const inventories = [
      [device('one')],
      [device('one', 'unauthorized'), device('two', 'offline')],
      [device('two')]
    ]
    const commits = []
    let listenerCalls = 0
    const watcher = new DeviceWatcher({
      adapter: { listDevices: async () => inventories.shift() },
      commit: async devices => commits.push(devices),
      now: () => now
    })
    watcher.subscribe(() => {
      throw new Error('listener failure must be isolated')
    })
    watcher.subscribe(() => listenerCalls += 1)

    assert.equal((await watcher.refresh())[0].observedAt, 100)
    now = 200
    assert.deepEqual((await watcher.refresh()).map(value => value.state), ['unauthorized', 'offline'])
    now = 300
    const third = await watcher.refresh()
    assert.deepEqual(third.map(value => [value.id, value.state]), [
      ['android:one', 'disconnected'],
      ['android:two', 'online']
    ])
    assert.equal(third[0].observedAt, 200)
    assert.equal(third[1].observedAt, 300)
    assert.equal(commits.length, 3)
    assert.equal(listenerCalls, 3)
    await watcher.close()
  })

  it('uses non-overlapping periodic polls and continues after adapter errors', async () => {
    const scheduler = fakeScheduler()
    const first = deferred()
    const second = deferred()
    let calls = 0
    const errors = []
    const watcher = new DeviceWatcher({
      adapter: {
        listDevices: () => {
          calls += 1
          if (calls === 1) return first.promise
          if (calls === 2) return second.promise
          return Promise.resolve([device('recovered')])
        }
      },
      clearTimeout: scheduler.clearTimeout,
      commit: async () => undefined,
      intervalMs: 10,
      onError: error => errors.push(error),
      setTimeout: scheduler.setTimeout
    })

    const started = watcher.start()
    assert.equal(calls, 1)
    assert.equal(scheduler.size(), 0)
    assert.equal(watcher.refresh(), started)
    first.resolve([device('first')])
    await started
    assert.equal(scheduler.size(), 1)

    scheduler.runNext()
    assert.equal(calls, 2)
    assert.equal(scheduler.size(), 0)
    const overlapping = watcher.refresh()
    second.reject(new Error('/private/adapter/path must not escape'))
    await assert.rejects(
      overlapping,
      error => error.code === 'service.unavailable' && !error.message.includes('/private/')
    )
    assert.equal(scheduler.size(), 1)

    scheduler.runNext()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(calls, 3)
    assert.equal(watcher.snapshot().find(value => value.id === 'android:recovered').state, 'online')
    assert.equal(errors.length, 1)
    await watcher.close()
  })

  it('aborts close and ignores an adapter result that arrives after close', async () => {
    const listing = deferred()
    let commitCalls = 0
    let signal
    const scheduler = fakeScheduler()
    const watcher = new DeviceWatcher({
      adapter: {
        listDevices: input => {
          signal = input.signal
          return listing.promise
        }
      },
      clearTimeout: scheduler.clearTimeout,
      commit: async () => commitCalls += 1,
      setTimeout: scheduler.setTimeout
    })
    const started = watcher.start()
    const closing = watcher.close()
    assert.equal(signal.aborted, true)
    listing.resolve([device('late')])
    assert.deepEqual(await started, [])
    await closing
    assert.equal(commitCalls, 0)
    assert.equal(scheduler.size(), 0)
    assert.deepEqual(watcher.snapshot(), [])
  })

  it('passes an abortable commit context and close waits for the commit gate', async () => {
    const committing = deferred()
    let committed = false
    let context
    const watcher = new DeviceWatcher({
      adapter: { listDevices: async () => [device('one')] },
      commit: async (_inventory, commitContext) => {
        context = commitContext
        await committing.promise
        if (!commitContext.signal.aborted) committed = true
      }
    })
    const started = watcher.start()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(context.generation, 1)
    const closing = watcher.close()
    assert.equal(context.signal.aborted, true)
    committing.resolve()
    await closing
    assert.deepEqual(await started, [])
    assert.equal(committed, false)
  })
})
