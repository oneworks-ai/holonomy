import { PROCESS_TERMINAL_STATES } from './constants.mjs'

const keyOf = process => `${process.id}:${process.generation}`

export class ProcessReconciler {
  #adapters
  #pending = new Map()

  constructor(options) {
    this.#adapters = options.adapterDispatcher
    this.onCleaned = options.onCleaned ?? (async () => undefined)
    this.onPending = options.onPending ?? (async () => undefined)
  }

  async open(snapshot) {
    for (const process of Object.values(snapshot.resources.processes)) {
      if (!PROCESS_TERMINAL_STATES.has(process.state) || process.cleanupPending === true) {
        this.#pending.set(keyOf(process), process)
      }
    }
    await this.#attempt()
  }

  async devices(devices, context = {}) {
    if (context.signal?.aborted) return
    const online = new Set(devices.filter(device => device.state === 'online').map(device => device.id))
    await this.#attempt(process => process.target !== 'android' || online.has(process.deviceId), context.signal)
  }

  async #attempt(predicate = () => true, signal) {
    for (const [key, process] of this.#pending) {
      if (signal?.aborted) return
      if (!predicate(process)) continue
      try {
        const result = await this.#adapters.target(process.target).reconcileProcess({ process, signal })
        if (result?.cleaned === true) {
          this.#pending.delete(key)
          await this.onCleaned(process)
        } else {
          await this.onPending(process)
        }
      } catch {
        await this.onPending(process)
      }
    }
  }
}
