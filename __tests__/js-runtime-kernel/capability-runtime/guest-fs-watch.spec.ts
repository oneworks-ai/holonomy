import { describe, expect, it } from 'vitest'

import {
  createCapabilityFsWatchIteratorV1,
  createCapabilityFsWatcherV1
} from '../../../packages/capabilities/fs/src/kernel/guest-fs-resources.js'

const watchHarness = (resourceType: 'filesystem.watch-iterator' | 'filesystem.watcher') => {
  let closed = 0
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
        return () => {
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
    get closed() {
      return closed
    }
  }
}

describe('filesystem watch queue limits', () => {
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
    harness.emit('change', 'late.txt')
    expect(harness.closed).toBe(1)
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
