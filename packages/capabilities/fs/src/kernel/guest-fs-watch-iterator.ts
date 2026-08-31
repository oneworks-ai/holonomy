import type { CapabilityGuestBridgeV1 } from '@holonomyjs/runtime/kernel/guest-facade-support'
import {
  capabilityResourceFieldsV1,
  readCapabilityResourceEventV1
} from '@holonomyjs/runtime/kernel/guest-facade-support'
import type { FsGuestResourceCallsV1 } from './guest-fs-resources.js'
import { fsAbortSignalV1, fsObjectV1, fsTargetV1 } from './guest-fs-support.js'
import { fsWatchErrorV1, fsWatchOptionsSnapshotV1, fsWatchQueueLimitV1 } from './guest-fs-watch-support.js'

export const createCapabilityFsWatchIteratorV1 = (
  bridge: CapabilityGuestBridgeV1,
  calls: FsGuestResourceCallsV1,
  path: unknown,
  options?: unknown
) => {
  const source = options == null ? {} : fsObjectV1(options)
  const signal = fsAbortSignalV1(source.signal)
  const resolved = fsTargetV1(path)
  const snapshot = calls.sync('node:fs/promises', 'watch', {
    options: fsWatchOptionsSnapshotV1(source),
    path: resolved.value
  }, resolved.fields)
  const fields = capabilityResourceFieldsV1(snapshot, 'filesystem.watch-iterator')
  const maxQueuedEvents = fsWatchQueueLimitV1(snapshot)
  const queue: unknown[] = []
  const waiting: Array<Readonly<{ reject(error: unknown): void; resolve(value: unknown): void }>> = []
  let failure: unknown
  let sequence = 0
  let terminal = false
  let removeAbort = () => {}
  const settleDone = () => {
    while (waiting.length > 0) waiting.shift()!.resolve({ done: true, value: undefined })
  }
  let dispose: (() => void) | undefined
  const stop = (error?: unknown) => {
    if (terminal) return
    terminal = true
    failure = error
    queue.length = 0
    dispose?.()
    removeAbort()
    calls.sync('node:fs', 'FSWatcher.close', {}, fields)
    if (failure == null) settleDone()
    else while (waiting.length > 0) waiting.shift()!.reject(failure)
  }
  dispose = bridge.subscribeResource?.(fields.bindingId, eventSource => {
    if (terminal) return
    const event = fsObjectV1(readCapabilityResourceEventV1(eventSource))
    const tuple = Array.isArray(event.tuple) ? event.tuple : []
    if (event.event === 'error') {
      terminal = true
      failure = tuple[0] instanceof Error ? tuple[0] : Object.assign(new Error('Filesystem watch failed'), tuple[0])
      dispose?.()
      removeAbort()
      while (waiting.length > 0) waiting.shift()!.reject(failure)
      return
    }
    if (event.event === 'close') {
      terminal = true
      dispose?.()
      removeAbort()
      settleDone()
      return
    }
    const value = Object.freeze({ eventType: tuple[0], filename: tuple[1] ?? null, sequence: ++sequence })
    const pending = waiting.shift()
    if (pending == null && queue.length >= maxQueuedEvents) {
      stop(fsWatchErrorV1('ENOSPC', 'Filesystem watch event queue overflow'))
    } else if (pending == null) queue.push(value)
    else pending.resolve({ done: false, value })
  })
  if (terminal) dispose?.()
  if (signal != null) {
    const abort = () => stop(fsWatchErrorV1('ABORT_ERR', 'The operation was aborted', 'AbortError'))
    removeAbort = () => signal.remove(abort)
    if (signal.readAborted()) abort()
    else signal.add(abort)
  }
  const iterator = Object.freeze({
    [Symbol.asyncIterator]() {
      return iterator
    },
    maxQueuedEvents,
    next() {
      if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() })
      if (failure != null) return Promise.reject(failure)
      if (terminal) return Promise.resolve({ done: true, value: undefined })
      return new Promise((resolve, reject) => waiting.push({ reject, resolve }))
    },
    return() {
      stop()
      return Promise.resolve({ done: true, value: undefined })
    },
    throw(error?: unknown) {
      stop()
      return Promise.reject(error instanceof Error ? error : new Error('Filesystem watch iterator aborted'))
    }
  })
  return iterator
}
