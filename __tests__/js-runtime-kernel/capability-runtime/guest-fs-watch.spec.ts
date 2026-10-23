import { describe, expect, it } from 'vitest'

import {
  createCapabilityFsWatchIteratorV1,
  createCapabilityFsWatcherV1
} from '../../../packages/capabilities/fs/src/kernel/guest-fs-resources.js'

const watchHarness = (resourceType: 'filesystem.watch-iterator' | 'filesystem.watcher') => {
  let closed = 0
  let unsubscribed = 0
  let lateListener: ((event: string) => void) | undefined
  let listener: ((event: string) => void) | undefined
  const snapshot = {
    binding: { bindingId: 'watch-1', generation: 1 },
    maxQueuedEvents: 1,
    resourceType
  }
  return {
    bridge: {
      invoke: async () => JSON.stringify({ ok: true, value: {} }),
      invokeSync: () => JSON.stringify({ ok: true, value: {} }),
      subscribeResource: (_bindingId: string, accepted: (event: string) => void) => {
        listener = accepted
        lateListener = accepted
        return () => {
          unsubscribed += 1
          listener = undefined
        }
      }
    },
    calls: {
      sync(_module: string, member: string) {
        if (member === 'watch') return snapshot
        if (member === 'FSWatcher.close') {
          closed += 1
          return {}
        }
        throw new Error(`Unexpected filesystem member: ${member}`)
      }
    },
    emit(eventType: 'change' | 'rename', filename: string) {
      listener?.(JSON.stringify({ event: 'change', tuple: [eventType, filename] }))
    },
    emitLate(eventType: 'change' | 'rename', filename: string) {
      lateListener?.(JSON.stringify({ event: 'change', tuple: [eventType, filename] }))
    },
    get unsubscribed() {
      return unsubscribed
    },
    error() {
      listener?.(JSON.stringify({ event: 'error', tuple: [{ code: 'ENOENT' }] }))
    },
    close() {
      listener?.(JSON.stringify({ event: 'close', tuple: [] }))
    },
    get closed() {
      return closed
    }
  }
}

describe('filesystem watch queue limits', () => {
  it('rebuilds Provider errors in the Guest realm and closes once', () => {
    const harness = watchHarness('filesystem.watcher')
    const watcher = createCapabilityFsWatcherV1(harness.bridge, harness.calls, 'holo-fs://workspace/', {})
    const errors: unknown[] = []
    let closed = 0
    watcher.on('error', (error: unknown) => errors.push(error))
    watcher.on('close', () => {
      closed += 1
    })
    harness.error()
    harness.close()
    watcher.close()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect(errors[0]).toMatchObject({ code: 'ENOENT', message: 'Filesystem watch failed' })
    expect(closed).toBe(1)
  })
  it('closes an FSWatcher exactly once when its AbortSignal fires', async () => {
    const harness = watchHarness('filesystem.watcher')
    const controller = new AbortController()
    const watcher = createCapabilityFsWatcherV1(
      harness.bridge,
      harness.calls,
      'holo-fs://workspace/',
      { maxQueuedEvents: 1, signal: controller.signal }
    )
    const events: string[] = []
    watcher.on('close', () => events.push('close'))

    controller.abort()
    await Promise.resolve()

    expect(events).toEqual(['close'])
    expect(harness.closed).toBe(1)
    watcher.close()
    harness.emit('change', 'late.txt')
    expect(harness.closed).toBe(1)
  })

  it('rejects a pending watch iterator read with AbortError and fences late events', async () => {
    const harness = watchHarness('filesystem.watch-iterator')
    const controller = new AbortController()
    const iterator = createCapabilityFsWatchIteratorV1(
      harness.bridge,
      harness.calls,
      'holo-fs://workspace/',
      { maxQueuedEvents: 1, signal: controller.signal }
    )
    const pending = iterator.next()

    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR', name: 'AbortError' })
    await expect(iterator.next()).rejects.toMatchObject({ code: 'ABORT_ERR', name: 'AbortError' })
    expect(harness.closed).toBe(1)
    harness.emit('change', 'late.txt')
    expect(harness.closed).toBe(1)
  })

  it('delivers a delayed event to a pending reader before enforcing queued-event overflow', async () => {
    const harness = watchHarness('filesystem.watch-iterator')
    const iterator = createCapabilityFsWatchIteratorV1(
      harness.bridge,
      harness.calls,
      'holo-fs://workspace/',
      { maxQueuedEvents: 1 }
    )
    let settled = false
    const pending = iterator.next().then(value => {
      settled = true
      return value
    })
    // The delivery gate stays closed until after next() has registered its reader.
    await Promise.resolve()
    expect(settled).toBe(false)
    harness.emit('rename', 'requested.txt')
    await expect(pending).resolves.toEqual({
      done: false,
      value: { eventType: 'rename', filename: 'requested.txt', sequence: 1 }
    })
    expect(harness.closed).toBe(0)
    harness.emit('change', 'queued.txt')
    harness.emit('change', 'overflow.txt')
    await expect(iterator.next()).rejects.toMatchObject({ code: 'ENOSPC' })
    harness.emitLate('change', 'late.txt')
    await expect(iterator.next()).rejects.toMatchObject({ code: 'ENOSPC' })
    await iterator.return()
    expect(harness.closed).toBe(1)
    expect(harness.unsubscribed).toBe(1)
  })

  it('terminates an async iterator with ENOSPC when the Policy-bounded queue overflows', async () => {
    const harness = watchHarness('filesystem.watch-iterator')
    const iterator = createCapabilityFsWatchIteratorV1(
      harness.bridge,
      harness.calls,
      'holo-fs://workspace/',
      { maxQueuedEvents: 1 }
    )

    expect(iterator.maxQueuedEvents).toBe(1)
    harness.emit('rename', 'first.txt')
    harness.emit('change', 'second.txt')

    await expect(iterator.next()).rejects.toMatchObject({ code: 'ENOSPC' })
    await expect(iterator.next()).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(harness.closed).toBe(1)
    harness.emitLate('change', 'late.txt')
    await expect(iterator.next()).rejects.toMatchObject({ code: 'ENOSPC' })
    await iterator.return()
    expect(harness.closed).toBe(1)
    expect(harness.unsubscribed).toBe(1)
  })

  it('closes within a change callback and fences reentrant and late delivery', async () => {
    const harness = watchHarness('filesystem.watcher')
    const watcher = createCapabilityFsWatcherV1(harness.bridge, harness.calls, 'holo-fs://workspace/', {})
    const events: string[] = []
    let closedDuringCallback: number | undefined
    watcher.on('close', () => events.push('close'))
    watcher.on('change', (_type: unknown, filename: unknown) => {
      events.push(`change:${String(filename)}`)
      watcher.close()
      closedDuringCallback = harness.closed
      harness.emitLate('change', 'reentrant.txt')
    })

    harness.emit('rename', 'target.txt')
    await Promise.resolve()
    harness.emitLate('change', 'late.txt')
    await Promise.resolve()
    watcher.close()
    expect(events).toEqual(['change:target.txt', 'close'])
    expect(closedDuringCallback).toBe(1)
    expect(harness.closed).toBe(1)
    expect(harness.unsubscribed).toBe(1)
  })

  it('delivers FSWatcher overflow as error then close exactly once', async () => {
    const harness = watchHarness('filesystem.watcher')
    const watcher = createCapabilityFsWatcherV1(
      harness.bridge,
      harness.calls,
      'holo-fs://workspace/',
      { maxQueuedEvents: 1 }
    )
    const events: string[] = []
    watcher.on('change', (_type: unknown, filename: unknown) => events.push(`change:${String(filename)}`))
    watcher.on('error', (error: { code: string }) => events.push(`error:${error.code}`))
    watcher.on('close', () => events.push('close'))

    expect(watcher.maxQueuedEvents).toBe(1)
    harness.emit('rename', 'first.txt')
    harness.emit('change', 'second.txt')
    await Promise.resolve()

    expect(events).toEqual(['error:ENOSPC', 'close'])
    expect(harness.closed).toBe(1)
    watcher.close()
    expect(harness.closed).toBe(1)
  })
})
