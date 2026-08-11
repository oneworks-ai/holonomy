import type { RuntimeTimerCallback, RuntimeTimerGlobals, RuntimeTimerHostPort, RuntimeTimers } from './types.js'

const MAX_DELAY_MS = 2_147_483_647
const FLOOR = Math.floor
const IS_FINITE = Number.isFinite
const IS_SAFE_INTEGER = Number.isSafeInteger

interface TimerRecord {
  readonly args: readonly unknown[]
  readonly callback: RuntimeTimerCallback
  readonly interval: boolean
}

const normalizeDelay = (value: unknown) => {
  const number = typeof value === 'number' ? value : Number(value ?? 0)
  if (!IS_FINITE(number) || number <= 0) return 0
  return Math.min(FLOOR(number), MAX_DELAY_MS)
}

export const createRuntimeTimers = (host: RuntimeTimerHostPort): RuntimeTimers => {
  if (host == null || typeof host.schedule !== 'function' || typeof host.cancel !== 'function') {
    throw new TypeError('Runtime timer host is invalid')
  }
  const schedule = host.schedule.bind(host)
  const cancel = host.cancel.bind(host)
  const records = new Map<number, TimerRecord>()
  let disposed = false

  const register = (
    callback: RuntimeTimerCallback,
    delay: unknown,
    interval: boolean,
    args: readonly unknown[]
  ) => {
    if (disposed) throw new Error('Runtime timers have been disposed')
    if (typeof callback !== 'function') throw new TypeError('Timer callback must be a function')
    const normalized = normalizeDelay(delay)
    const id = schedule(normalized, interval ? normalized : undefined)
    if (!IS_SAFE_INTEGER(id) || id <= 0 || records.has(id)) {
      try {
        cancel(id)
      } catch {
        // Admission has already failed; host cleanup is best effort.
      }
      throw new Error('Runtime timer host returned an invalid identifier')
    }
    records.set(id, Object.freeze({ args: Object.freeze([...args]), callback, interval }))
    return id
  }

  const clear = (timerId: number) => {
    if (!IS_SAFE_INTEGER(timerId) || !records.delete(timerId)) return
    try {
      cancel(timerId)
    } catch {
      // Clear remains idempotent across host teardown.
    }
  }

  const globals: RuntimeTimerGlobals = Object.freeze({
    clearInterval: clear,
    clearTimeout: clear,
    setInterval: (callback: RuntimeTimerCallback, delay?: number, ...args: unknown[]) =>
      register(callback, delay, true, args),
    setTimeout: (callback: RuntimeTimerCallback, delay?: number, ...args: unknown[]) =>
      register(callback, delay, false, args)
  })

  return Object.freeze({
    ...globals,
    dispose() {
      if (disposed) return
      disposed = true
      const ids = [...records.keys()]
      records.clear()
      for (let index = 0; index < ids.length; index += 1) {
        try {
          cancel(ids[index]!)
        } catch {
          // Adapter disposal owns final native cleanup.
        }
      }
    },
    fire(timerId: number) {
      if (disposed || !IS_SAFE_INTEGER(timerId)) return false
      const record = records.get(timerId)
      if (record == null) return false
      if (!record.interval) records.delete(timerId)
      record.callback(...record.args)
      return true
    },
    globals,
    syntheticModule: globals
  })
}
