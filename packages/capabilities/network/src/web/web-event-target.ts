export type AbortListener = (event: { type: 'abort' }) => void
type AbortRegistration = EventListenerOrEventListenerObject | AbortListener
const CLEAR_LISTENERS = new WeakMap<object, (type: string) => void>()

export const reportListenerError = (error: unknown) => {
  const raise = () => {
    throw error
  }
  // Listener errors are reported asynchronously; they must not stop native
  // cancellation listeners or turn AbortController.abort() into a throw.
  try {
    if (typeof globalThis.queueMicrotask === 'function') globalThis.queueMicrotask(raise)
    else void Promise.resolve().then(raise)
  } catch {
    // A replaced or failing error reporter must not stop cancellation.
  }
}

/** Bare-V8 EventTarget shape used by the shared NativeBridge signal admission. */
export class WebEventTarget {
  readonly #listeners = new Map<string, Map<AbortRegistration, AbortListener>>()

  constructor() {
    CLEAR_LISTENERS.set(this, type => this.#listeners.delete(type))
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | AbortListener | null) {
    if (listener == null) return
    const callback = typeof listener === 'function'
      ? listener as AbortListener
      : (event: { type: 'abort' }) => listener.handleEvent(event as unknown as Event)
    let listeners = this.#listeners.get(type)
    if (listeners == null) {
      listeners = new Map()
      this.#listeners.set(type, listeners)
    }
    listeners.set(listener, callback)
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | AbortListener | null) {
    if (listener == null) return
    const listeners = this.#listeners.get(type)
    listeners?.delete(listener)
    if (listeners?.size === 0) this.#listeners.delete(type)
  }

  dispatchEvent(event: { type: 'abort' }) {
    for (const listener of [...this.#listeners.get(event.type)?.values() ?? []]) {
      try {
        listener(event)
      } catch (error) {
        reportListenerError(error)
      }
    }
  }
}

/** The genuine Abort transition clears listeners; synthetic events do not. */
export const clearWebEventListeners = (target: WebEventTarget, type: string) => {
  CLEAR_LISTENERS.get(target)?.(type)
}
