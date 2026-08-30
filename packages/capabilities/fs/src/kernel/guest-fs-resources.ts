import type { CapabilityGuestBridgeV1 } from '@holonomyjs/runtime/kernel/guest-facade-support'
import {
  capabilityResourceFieldsV1,
  readCapabilityResourceEventV1
} from '@holonomyjs/runtime/kernel/guest-facade-support'
import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'
import { fsAbortSignalV1, fsFunctionV1, fsObjectV1, fsTargetV1, invalidFsValueV1 } from './guest-fs-support.js'
import type { FsCapabilityFieldsV1 } from './guest-fs-support.js'
import { fsWatchErrorV1, fsWatchOptionsSnapshotV1, fsWatchQueueLimitV1 } from './guest-fs-watch-support.js'

export { createCapabilityFsWatchIteratorV1 } from './guest-fs-watch-iterator.js'

export interface FsGuestResourceCallsV1 {
  sync(module: string, member: string, args: JsonValueV1, fields: FsCapabilityFieldsV1): unknown
}

const emitter = () => {
  const listeners = new Map<string, Set<(...args: unknown[]) => unknown>>()
  return {
    emit(event: string, ...args: unknown[]) {
      for (const callback of listeners.get(event) ?? []) {
        try {
          callback(...args)
        } catch {
          // Listener failures never affect the Provider resource.
        }
      }
    },
    on(event: unknown, callback: unknown) {
      if (typeof event !== 'string') return invalidFsValueV1('Invalid watcher event')
      const accepted = fsFunctionV1(callback)
      let callbacks = listeners.get(event)
      if (callbacks == null) {
        callbacks = new Set()
        listeners.set(event, callbacks)
      }
      callbacks.add(accepted)
    }
  }
}

export const createCapabilityFsWatcherV1 = (
  bridge: CapabilityGuestBridgeV1,
  calls: FsGuestResourceCallsV1,
  path: unknown,
  options: unknown,
  listener?: unknown
) => {
  const listenerShorthand = listener == null && typeof options === 'function'
  const callbackValue = listenerShorthand ? options : listener
  const source = listenerShorthand || options == null ? {} : fsObjectV1(options)
  const signal = fsAbortSignalV1(source.signal)
  const resolved = fsTargetV1(path)
  const snapshot = calls.sync('node:fs', 'watch', {
    options: fsWatchOptionsSnapshotV1(source),
    path: resolved.value
  }, resolved.fields)
  const fields = capabilityResourceFieldsV1(snapshot, 'filesystem.watcher')
  const maxQueuedEvents = fsWatchQueueLimitV1(snapshot)
  const events = emitter()
  const queue: unknown[][] = []
  let closed = false
  let closeEmitted = false
  let flushScheduled = false
  let dispose: (() => void) | undefined
  let removeAbort = () => {}
  const emitClose = () => {
    if (closeEmitted) return
    closeEmitted = true
    events.emit('close')
  }
  const closeProvider = () => {
    if (closed) return
    closed = true
    queue.length = 0
    dispose?.()
    removeAbort()
    calls.sync('node:fs', 'FSWatcher.close', {}, fields)
    emitClose()
  }
  const overflow = () => {
    if (closed) return
    closed = true
    queue.length = 0
    dispose?.()
    removeAbort()
    try {
      calls.sync('node:fs', 'FSWatcher.close', {}, fields)
    } finally {
      events.emit('error', fsWatchErrorV1('ENOSPC', 'Filesystem watch event queue overflow'))
      emitClose()
    }
  }
  const flush = () => {
    flushScheduled = false
    if (closed) return
    while (queue.length > 0) events.emit('change', ...queue.shift()!)
  }
  dispose = bridge.subscribeResource?.(fields.bindingId, source => {
    if (closed) return
    const event = fsObjectV1(readCapabilityResourceEventV1(source))
    const tuple = Array.isArray(event.tuple) ? event.tuple : []
    if (event.event === 'close') {
      closed = true
      dispose?.()
      removeAbort()
      emitClose()
      return
    }
    if (event.event === 'error') {
      events.emit('error', ...tuple)
      return
    }
    if (queue.length >= maxQueuedEvents) return overflow()
    queue.push(tuple)
    if (!flushScheduled) {
      flushScheduled = true
      void Promise.resolve().then(flush)
    }
  })
  if (closed) dispose?.()
  const watcher = Object.freeze({
    close() {
      closeProvider()
    },
    on(event: unknown, callback: unknown) {
      events.on(event, callback)
      return watcher
    },
    maxQueuedEvents
  })
  if (signal != null) {
    const abort = () => closeProvider()
    removeAbort = () => signal.remove(abort)
    if (signal.readAborted()) abort()
    else signal.add(abort)
  }
  if (typeof callbackValue === 'function') watcher.on('change', callbackValue)
  return watcher
}
