import type { CapabilityGuestBridgeV1 } from './guest-facade-support.js'
import { capabilityResourceFieldsV1, readCapabilityResourceEventV1 } from './guest-facade-support.js'
import { fsFunctionV1, fsJsonObjectV1, fsObjectV1, fsTargetV1, invalidFsValueV1 } from './guest-fs-support.js'
import type { FsCapabilityFieldsV1 } from './guest-fs-support.js'
import type { JsonValueV1 } from './json-types.js'

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
  const callbackValue = listener ?? options
  const resolved = fsTargetV1(path)
  const snapshot = calls.sync('node:fs', 'watch', {
    options: listener == null ? {} : fsJsonObjectV1(options),
    path: resolved.value
  }, resolved.fields)
  const fields = capabilityResourceFieldsV1(snapshot, 'filesystem.watcher')
  const events = emitter()
  let closed = false
  const dispose = bridge.subscribeResource?.(fields.bindingId, source => {
    const event = fsObjectV1(readCapabilityResourceEventV1(source))
    const tuple = Array.isArray(event.tuple) ? event.tuple : []
    if (event.event === 'close') closed = true
    events.emit(String(event.event), ...tuple)
  })
  const watcher = Object.freeze({
    close() {
      if (closed) return
      closed = true
      calls.sync('node:fs', 'FSWatcher.close', {}, fields)
      dispose?.()
      events.emit('close')
    },
    on(event: unknown, callback: unknown) {
      events.on(event, callback)
      return watcher
    }
  })
  if (typeof callbackValue === 'function') watcher.on('change', callbackValue)
  return watcher
}

export const createCapabilityFsWatchIteratorV1 = (
  bridge: CapabilityGuestBridgeV1,
  calls: FsGuestResourceCallsV1,
  path: unknown,
  options?: unknown
) => {
  const source = options == null ? {} : fsObjectV1(options)
  const resolved = fsTargetV1(path)
  const snapshot = calls.sync('node:fs/promises', 'watch', {
    options: fsJsonObjectV1(source),
    path: resolved.value
  }, resolved.fields)
  const fields = capabilityResourceFieldsV1(snapshot, 'filesystem.watch-iterator')
  const queue: unknown[] = []
  const waiting: Array<Readonly<{ reject(error: unknown): void; resolve(value: unknown): void }>> = []
  let failure: unknown
  let sequence = 0
  let terminal = false
  const settleDone = () => {
    while (waiting.length > 0) waiting.shift()!.resolve({ done: true, value: undefined })
  }
  const dispose = bridge.subscribeResource?.(fields.bindingId, eventSource => {
    if (terminal) return
    const event = fsObjectV1(readCapabilityResourceEventV1(eventSource))
    const tuple = Array.isArray(event.tuple) ? event.tuple : []
    if (event.event === 'error') {
      terminal = true
      failure = tuple[0] instanceof Error ? tuple[0] : Object.assign(new Error('Filesystem watch failed'), tuple[0])
      while (waiting.length > 0) waiting.shift()!.reject(failure)
      return
    }
    if (event.event === 'close') {
      terminal = true
      settleDone()
      return
    }
    const value = Object.freeze({ eventType: tuple[0], filename: tuple[1] ?? null, sequence: ++sequence })
    const pending = waiting.shift()
    if (pending == null) queue.push(value)
    else pending.resolve({ done: false, value })
  })
  const closeIterator = () => {
    if (terminal) return
    terminal = true
    calls.sync('node:fs', 'FSWatcher.close', {}, fields)
    dispose?.()
    settleDone()
  }
  const signal = source.signal
  if (signal != null && typeof signal === 'object' && 'aborted' in signal) {
    const abort = () => {
      closeIterator()
      failure = Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR', name: 'AbortError' })
    }
    if ((signal as { aborted?: unknown }).aborted === true) abort()
    else if (typeof (signal as { addEventListener?: unknown }).addEventListener === 'function') {
      ;(signal as unknown as { addEventListener(type: string, callback: () => void, options: object): void })
        .addEventListener('abort', abort, { once: true })
    }
  }
  const iterator = Object.freeze({
    [Symbol.asyncIterator]() {
      return iterator
    },
    next() {
      if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() })
      if (failure != null) return Promise.reject(failure)
      if (terminal) return Promise.resolve({ done: true, value: undefined })
      return new Promise((resolve, reject) => waiting.push({ reject, resolve }))
    },
    return() {
      closeIterator()
      return Promise.resolve({ done: true, value: undefined })
    },
    throw(error?: unknown) {
      closeIterator()
      return Promise.reject(error instanceof Error ? error : new Error('Filesystem watch iterator aborted'))
    }
  })
  return iterator
}
