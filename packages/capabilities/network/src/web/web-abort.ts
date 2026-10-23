/* eslint-disable max-lines -- one Abort brand owns composition, timers and transitions. */

import { WebEventTarget, clearWebEventListeners, reportListenerError } from './web-event-target.js'

import type { AbortListener } from './web-event-target.js'

export { WebEventTarget } from './web-event-target.js'

/** Only the monotonic Event Loop is allowed to schedule Runtime abort timeouts. */
export interface WebAbortTimerPort {
  getCurrentTime(): number
  setTimeout(callback: () => void, delayMs: number, options: { ref: false }): number
  clearTimeout(timerId: number): boolean
  addLifecycleObserver(observer: () => void): () => boolean
}

const MAX_ABORT_DELAY_MS = 4_294_967_295
const ADD_ABORT_LISTENER = WebEventTarget.prototype.addEventListener
const REMOVE_ABORT_LISTENER = WebEventTarget.prototype.removeEventListener
const DISPATCH_ABORT_EVENT = WebEventTarget.prototype.dispatchEvent

class WebAbortReason extends Error {
  constructor() {
    super('The operation was aborted')
    this.name = 'AbortError'
  }
}

class WebTimeoutReason extends Error {
  constructor() {
    super('The operation timed out')
    this.name = 'TimeoutError'
  }
}

function assertDelay(milliseconds: unknown): asserts milliseconds is number {
  if (typeof milliseconds !== 'number') {
    throw new TypeError('Abort timeout must be a number')
  }
  if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > MAX_ABORT_DELAY_MS) {
    throw new RangeError('Abort timeout must be an integer from 0 to 4294967295')
  }
}

interface AbortState {
  aborted: boolean
  reason: unknown
}

const createConstructors = (timerPort?: WebAbortTimerPort) => {
  const states = new WeakMap<object, AbortState>()
  const timers = new Set<number>()
  let disposed = false
  let removeLifecycleObserver: (() => boolean) | undefined

  class AbortSignal extends WebEventTarget {
    static abort(reason?: unknown) {
      const signal = new this()
      transition(signal, reason)
      return signal
    }

    static any(signals: readonly globalThis.AbortSignal[]) {
      if (signals == null) throw new TypeError('AbortSignal.any requires an iterable of AbortSignals')
      // Snapshot and validate the entire sequence before subscribing. A Proxy
      // around a real signal has no brand and cannot impersonate one here.
      const inputs = [...signals]
      for (const input of inputs) {
        if (input == null || typeof input !== 'object' || !states.has(input)) {
          throw new TypeError('AbortSignal.any requires genuine AbortSignals')
        }
      }
      const signal = new this()
      const unique = [...new Set(inputs)]
      const alreadyAborted = unique.find(input => states.get(input)!.aborted)
      if (alreadyAborted != null) {
        transition(signal, states.get(alreadyAborted)!.reason)
        return signal
      }

      const subscribed: Array<{ input: globalThis.AbortSignal; listener: EventListener }> = []
      const detach = () => {
        for (const { input, listener } of subscribed) {
          REMOVE_ABORT_LISTENER.call(input as unknown as WebEventTarget, 'abort', listener)
        }
        subscribed.length = 0
      }
      try {
        for (const input of unique) {
          const listener: EventListener = () => {
            const sourceState = states.get(input)!
            if (!sourceState.aborted) return
            detach()
            transition(signal, sourceState.reason)
          }
          ADD_ABORT_LISTENER.call(input as unknown as WebEventTarget, 'abort', listener)
          subscribed.push({ input, listener })
        }
      } catch (error) {
        detach()
        throw error
      }
      return signal
    }

    static timeout(milliseconds: number) {
      assertDelay(milliseconds)
      if (timerPort == null || disposed) {
        throw new TypeError('AbortSignal.timeout requires an active Runtime Event Loop')
      }
      const signal = new this()
      const deadline = timerPort.getCurrentTime() + milliseconds
      const arm = () => {
        // RuntimeEventLoop clamps each timer to its configured maximum. Check
        // the monotonic deadline and rearm on that same loop when necessary.
        const remaining = Math.max(0, deadline - timerPort.getCurrentTime())
        const timerId = timerPort.setTimeout(
          () => {
            timers.delete(timerId)
            if (disposed) return
            if (timerPort.getCurrentTime() < deadline) arm()
            else transition(signal, new WebTimeoutReason())
          },
          remaining,
          { ref: false }
        )
        timers.add(timerId)
      }
      arm()
      return signal
    }

    constructor() {
      super()
      states.set(this, { aborted: false, reason: undefined })
    }

    get aborted() {
      const state = states.get(this)
      if (state == null) throw new TypeError('Invalid AbortSignal receiver')
      return state.aborted
    }

    get reason() {
      const state = states.get(this)
      if (state == null) throw new TypeError('Invalid AbortSignal receiver')
      return state.reason
    }

    onabort: AbortListener | null = null

    throwIfAborted() {
      const state = states.get(this)
      if (state == null) throw new TypeError('Invalid AbortSignal receiver')
      if (state.aborted) throw state.reason
    }
  }

  function transition(signal: AbortSignal, reason: unknown) {
    const state = states.get(signal)
    if (state == null) throw new TypeError('Invalid AbortSignal receiver')
    if (state.aborted) return
    state.aborted = true
    state.reason = reason === undefined ? new WebAbortReason() : reason
    const event = Object.freeze({ type: 'abort' as const })
    try {
      signal.onabort?.(event)
    } catch (error) {
      reportListenerError(error)
    }
    DISPATCH_ABORT_EVENT.call(signal, event)
    clearWebEventListeners(signal, 'abort')
  }

  const controllerSignals = new WeakMap<object, AbortSignal>()
  class AbortController {
    constructor() {
      controllerSignals.set(this, new AbortSignal())
    }

    get signal() {
      const signal = controllerSignals.get(this)
      if (signal == null) throw new TypeError('Invalid AbortController receiver')
      return signal
    }

    abort(reason?: unknown) {
      const signal = controllerSignals.get(this)
      if (signal == null) throw new TypeError('Invalid AbortController receiver')
      transition(signal, reason)
    }
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const timerId of timers) timerPort?.clearTimeout(timerId)
    timers.clear()
    removeLifecycleObserver?.()
  }
  if (timerPort != null) removeLifecycleObserver = timerPort.addLifecycleObserver(dispose)
  return Object.freeze({ AbortController, AbortSignal, dispose })
}

const DEFAULT_CONSTRUCTORS = createConstructors()
export const WebAbortController = DEFAULT_CONSTRUCTORS.AbortController
export const WebAbortSignal = DEFAULT_CONSTRUCTORS.AbortSignal

/** Creates one Abort brand and timeout ledger for one composed Runtime. */
export const createWebAbortConstructors = (timerPort: WebAbortTimerPort) => createConstructors(timerPort)

export const DEFAULT_ABORT_CONSTRUCTORS = Object.freeze({
  AbortController: WebAbortController as unknown as typeof globalThis.AbortController,
  AbortSignal: WebAbortSignal as unknown as typeof globalThis.AbortSignal
})
