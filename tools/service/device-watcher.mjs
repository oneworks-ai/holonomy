import { HolonomyServiceError, serviceError } from './errors.mjs'
import { validateDeviceInput } from './registry-helpers.mjs'
import { cloneJson, requireInteger, requireRecord } from './validation.mjs'

const DEFAULT_REFRESH_INTERVAL_MS = 5_000
const DEFAULT_MAX_DEVICES = 256

const watcherUnavailable = () =>
  serviceError(
    'service.unavailable',
    'Holonomy Service device inventory refresh failed',
    { retryable: true }
  )

const normalizeError = error => error instanceof HolonomyServiceError ? error : watcherUnavailable()

export class DeviceWatcher {
  #adapter
  #clearTimeout
  #closed = false
  #commit
  #controller
  #devices = new Map()
  #generation = 0
  #intervalMs
  #listeners = new Set()
  #maxDevices
  #now
  #onError
  #pending
  #setTimeout
  #started = false
  #timer

  constructor(options = {}) {
    const value = requireRecord(options, 'Device watcher options')
    if (value.adapter == null || typeof value.adapter.listDevices !== 'function') {
      throw serviceError('service.invalid_request', 'Device watcher adapter is invalid')
    }
    if (typeof value.commit !== 'function') {
      throw serviceError('service.invalid_request', 'Device watcher commit must be a function')
    }
    this.#adapter = value.adapter
    this.#commit = value.commit
    this.#intervalMs = requireInteger(
      value.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
      'Device refresh interval',
      { min: 1 }
    )
    this.#maxDevices = requireInteger(value.maxDevices ?? DEFAULT_MAX_DEVICES, 'Device inventory limit', {
      min: 1
    })
    this.#now = value.now ?? Date.now
    this.#setTimeout = value.setTimeout ?? globalThis.setTimeout
    this.#clearTimeout = value.clearTimeout ?? globalThis.clearTimeout
    this.#onError = value.onError ?? (() => undefined)
    for (
      const [candidate, label] of [
        [this.#now, 'Device watcher clock'],
        [this.#setTimeout, 'Device watcher scheduler'],
        [this.#clearTimeout, 'Device watcher timer cancellation'],
        [this.#onError, 'Device watcher error listener']
      ]
    ) {
      if (typeof candidate !== 'function') {
        throw serviceError('service.invalid_request', `${label} must be a function`)
      }
    }
  }

  start() {
    this.#assertOpen()
    if (this.#started) return this.#pending ?? Promise.resolve(this.snapshot())
    this.#started = true
    return this.refresh()
  }

  refresh() {
    this.#assertOpen()
    if (this.#pending != null) return this.#pending
    if (this.#timer != null) {
      this.#clearTimeout(this.#timer)
      this.#timer = undefined
    }
    return this.#run()
  }

  snapshot() {
    return [...this.#devices.values()].sort((left, right) => left.id.localeCompare(right.id)).map(cloneJson)
  }

  subscribe(listener) {
    this.#assertOpen()
    if (typeof listener !== 'function') throw serviceError('service.invalid_request', 'Invalid device watcher listener')
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async close() {
    const pending = this.#pending
    if (this.#closed) return await pending?.catch(() => undefined)
    this.#closed = true
    this.#started = false
    this.#generation += 1
    if (this.#timer != null) this.#clearTimeout(this.#timer)
    this.#timer = undefined
    this.#controller?.abort()
    this.#controller = undefined
    this.#listeners.clear()
    await pending?.catch(() => undefined)
  }

  #assertOpen() {
    if (this.#closed) throw serviceError('service.unavailable', 'Holonomy Service device watcher is closed')
  }

  #run() {
    const generation = ++this.#generation
    const controller = new AbortController()
    this.#controller = controller
    const pending = this.#poll(generation, controller.signal)
      .catch(error => {
        if (this.#closed || generation !== this.#generation) return this.snapshot()
        throw normalizeError(error)
      })
      .finally(() => {
        if (this.#pending === pending) this.#pending = undefined
        if (this.#controller === controller) this.#controller = undefined
        if (this.#started && !this.#closed && generation === this.#generation) this.#schedule()
      })
    this.#pending = pending
    return pending
  }

  async #poll(generation, signal) {
    const inputs = await this.#adapter.listDevices({ signal })
    if (this.#closed || signal.aborted || generation !== this.#generation) return this.snapshot()
    const next = this.#normalizeInventory(inputs)
    const inventory = [...next.values()].sort((left, right) => left.id.localeCompare(right.id)).map(cloneJson)
    await this.#commit(cloneJson(inventory), { generation, signal })
    if (this.#closed || signal.aborted || generation !== this.#generation) return this.snapshot()
    this.#devices = next
    for (const listener of [...this.#listeners]) {
      try {
        listener(cloneJson(inventory))
      } catch (error) {
        this.#reportError(normalizeError(error))
      }
    }
    return cloneJson(inventory)
  }

  #normalizeInventory(inputs) {
    if (!Array.isArray(inputs)) {
      throw serviceError('service.invalid_request', 'Device inventory must be an array')
    }
    if (inputs.length > this.#maxDevices) {
      throw serviceError('service.limit_exceeded', 'Device inventory exceeds its limit')
    }
    const now = requireInteger(this.#now(), 'Device watcher clock', { min: 0 })
    const next = new Map()
    for (const input of inputs) {
      const device = validateDeviceInput(input, now)
      if (next.has(device.id)) {
        throw serviceError('service.invalid_request', 'Device inventory contains a duplicate id')
      }
      next.set(device.id, device)
    }
    for (const previous of this.#devices.values()) {
      if (!next.has(previous.id)) next.set(previous.id, { ...previous, state: 'disconnected' })
    }
    if (next.size > this.#maxDevices) {
      const disconnected = [...next.values()]
        .filter(device => device.state === 'disconnected' && !inputs.some(input => input?.id === device.id))
        .sort((left, right) => left.observedAt - right.observedAt || left.id.localeCompare(right.id))
      while (next.size > this.#maxDevices && disconnected.length > 0) next.delete(disconnected.shift().id)
    }
    if (next.size > this.#maxDevices) {
      throw serviceError('service.limit_exceeded', 'Device inventory exceeds its limit')
    }
    return next
  }

  #schedule() {
    if (this.#timer != null || this.#pending != null || this.#closed || !this.#started) return
    this.#timer = this.#setTimeout(() => {
      this.#timer = undefined
      const pending = this.#run()
      void pending.catch(error => this.#reportError(error))
    }, this.#intervalMs)
  }

  #reportError(error) {
    try {
      this.#onError(normalizeError(error))
    } catch {
      // Error observers must not terminate the watcher.
    }
  }
}
