// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { trustedInvocationValueFromJsonV1 } from '../../../dist/capability-runtime/index.js'

export class ProcessCallbackEventChannelV1 {
  #closed
  #listeners = new Set()

  close() {
    if (this.#closed != null) return
    this.#closed = trustedInvocationValueFromJsonV1({ event: 'close' }, 'result')
    this.#deliver(this.#closed)
    this.#listeners.clear()
  }

  emit(value) {
    if (this.#closed != null) return false
    this.#deliver(trustedInvocationValueFromJsonV1(value, 'result'))
    return true
  }

  subscribe(listener) {
    if (this.#closed != null) queueMicrotask(() => this.#notify(listener, this.#closed))
    else this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #deliver(value) {
    for (const listener of this.#listeners) this.#notify(listener, value)
  }

  #notify(listener, value) {
    try {
      listener(value)
    } catch {
      // Host delivery failures never affect process state or other subscribers.
    }
  }
}

export class ProcessEventChannelV1 {
  #closed = false
  #events = []
  #listeners = new Map()
  #maximum
  #paused = false
  #size = 0

  constructor(maximum) {
    this.#maximum = maximum
  }

  emit(value, bytes = 0) {
    if (this.#closed) return false
    if (this.#size + bytes > this.#maximum) return false
    this.#size += bytes
    this.#events.push(trustedInvocationValueFromJsonV1(value, 'result'))
    if (value.event === 'close') {
      this.#closed = true
      this.#paused = false
    }
    this.#drainAll()
    return true
  }

  fail(error) {
    if (this.#closed) return
    this.emit({ event: 'error', tuple: [error] })
    this.emit({ event: 'close', tuple: [] })
  }

  pause() {
    this.#paused = true
  }

  resume() {
    if (!this.#paused) return
    this.#paused = false
    this.#drainAll()
  }

  subscribe(listener) {
    this.#listeners.set(listener, 0)
    queueMicrotask(() => this.#drain(listener))
    return () => this.#listeners.delete(listener)
  }

  #drain(listener) {
    while (!this.#paused) {
      const cursor = this.#listeners.get(listener)
      if (cursor == null || cursor >= this.#events.length) return
      this.#listeners.set(listener, cursor + 1)
      try {
        listener(this.#events[cursor])
      } catch {
        // Host delivery failures never affect process state or other subscribers.
      }
    }
  }

  #drainAll() {
    if (this.#paused) return
    for (const listener of this.#listeners.keys()) this.#drain(listener)
  }
}
