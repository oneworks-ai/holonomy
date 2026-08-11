import { PROCESS_TERMINAL_STATES } from './constants.mjs'

const processKey = process => `${process.id}:${process.generation}`

const terminalExit = event => {
  const code = Number.isSafeInteger(event.exit?.code) && event.exit.code >= 0 && event.exit.code <= 255
    ? event.exit.code
    : event.state === 'exited'
    ? 0
    : 1
  return { code, reason: event.exit?.reason ?? event.state }
}

export class ProcessLifecycleWatcher {
  #adapters
  #closeLeases
  #pending = new Set()
  #registry
  #schedule
  #unsubscribers = new Map()

  constructor(options) {
    this.#adapters = options.adapterDispatcher
    this.#closeLeases = options.closeLeases
    this.#registry = options.registry
    this.#schedule = options.schedule
  }

  async watch(process) {
    this.unwatch(process)
    const adapter = this.#adapters.target(process.target)
    const unsubscribe = await adapter.subscribeProcess({
      onTerminal: event => this.#onTerminal(process, event),
      process
    })
    if (typeof unsubscribe === 'function') this.#unsubscribers.set(processKey(process), unsubscribe)
  }

  unwatch(process) {
    const key = processKey(process)
    this.#unsubscribers.get(key)?.()
    this.#unsubscribers.delete(key)
  }

  close() {
    for (const unsubscribe of this.#unsubscribers.values()) unsubscribe()
    this.#unsubscribers.clear()
  }

  lost(process, reason) {
    const event = {
      exit: { reason },
      generation: process.generation,
      state: 'lost'
    }
    const key = processKey(process)
    if (this.#pending.has(key)) return
    this.#pending.add(key)
    this.#schedule(process.deviceId, `host-lost:${key}`, async signal => {
      try {
        await this.#adapters.target(process.target).stopProcess({ process, signal }).catch(() => undefined)
        await this.#settle(process, event)
      } finally {
        this.#pending.delete(key)
      }
    })
  }

  #onTerminal(process, event) {
    if (event?.generation !== process.generation || !PROCESS_TERMINAL_STATES.has(event?.state)) return
    const key = processKey(process)
    if (this.#pending.has(key)) return
    this.#pending.add(key)
    this.#schedule(process.deviceId, `terminal:${key}`, async () => {
      try {
        await this.#settle(process, event)
      } finally {
        this.#pending.delete(key)
      }
    })
  }

  async #settle(process, event) {
    let current
    try {
      current = this.#registry.get('processes', process.id, 'Runtime process')
    } catch {
      return
    }
    if (
      current.generation !== process.generation || PROCESS_TERMINAL_STATES.has(current.state) ||
      current.state === 'stopping'
    ) return
    this.unwatch(process)
    await this.#closeLeases(process)
    await this.#registry.updateProcess(process.id, process.generation, {
      activeOperationId: null,
      exit: terminalExit(event),
      state: event.state
    })
  }
}
