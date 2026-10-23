export class ProcessCallbackEventChannelV1 {
  #closed
  #listeners = new Set()

  #trusted

  constructor(trustedInvocationValueFromJsonV1) {
    this.#trusted = trustedInvocationValueFromJsonV1
  }

  close() {
    if (this.#closed != null) return
    this.#closed = this.#trusted({ event: 'close' }, 'result')
    this.#deliver(this.#closed)
    this.#listeners.clear()
  }

  emit(value) {
    if (this.#closed != null) return false
    this.#deliver(this.#trusted(value, 'result'))
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

const MAX_RETAINED_EVENTS = 4096
const TERMINAL_SLOTS = 2

export class ProcessEventChannelV1 {
  #closed = false
  #errorEmitted = false
  #events = []
  #listeners = new Map()
  #maximum
  #paused = false
  #size = 0
  #trusted

  constructor(maximum, trustedInvocationValueFromJsonV1) {
    this.#maximum = maximum
    this.#trusted = trustedInvocationValueFromJsonV1
  }

  canAccept(bytes) {
    return !this.#closed && Number.isSafeInteger(bytes) && bytes >= 0 &&
      this.#events.length < MAX_RETAINED_EVENTS - TERMINAL_SLOTS &&
      bytes <= this.#maximum - this.#size
  }

  emit(value, bytes = 0) {
    if (this.#closed) return false
    if (value.event === 'error') {
      if (this.#errorEmitted || this.#events.length >= MAX_RETAINED_EVENTS - 1) return false
    } else if (value.event === 'close') {
      if (this.#events.length >= MAX_RETAINED_EVENTS) return false
    } else if (this.#events.length >= MAX_RETAINED_EVENTS - TERMINAL_SLOTS) return false
    if (this.#size + bytes > this.#maximum) return false
    this.#size += bytes
    this.#events.push(this.#trusted(value, 'result'))
    if (value.event === 'error') this.#errorEmitted = true
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
