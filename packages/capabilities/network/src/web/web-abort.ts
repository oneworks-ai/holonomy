type AbortListener = (event: { type: 'abort' }) => void

class WebAbortReason extends Error {
  constructor() {
    super('The operation was aborted')
    this.name = 'AbortError'
  }
}

export class WebAbortSignal {
  static abort(reason?: unknown) {
    const controller = new WebAbortController()
    controller.abort(reason)
    return controller.signal
  }

  static any(signals: readonly AbortSignal[]) {
    const controller = new WebAbortController()
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason)
        break
      }
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
    }
    return controller.signal
  }

  static timeout(milliseconds: number) {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new TypeError('Abort timeout must be a non-negative integer')
    }
    throw new TypeError('AbortSignal.timeout requires an injected host implementation')
  }

  aborted = false
  onabort: AbortListener | null = null
  reason: unknown = undefined
  private readonly listeners = new Set<AbortListener>()

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | AbortListener | null) {
    if (type !== 'abort' || listener == null) return
    const callback = typeof listener === 'function'
      ? listener as AbortListener
      : (event: { type: 'abort' }) => listener.handleEvent(event as unknown as Event)
    this.listeners.add(callback)
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | AbortListener | null) {
    if (type === 'abort' && typeof listener === 'function') {
      this.listeners.delete(listener as AbortListener)
    }
  }

  throwIfAborted() {
    if (this.aborted) throw this.reason
  }

  dispatchAbort(reason: unknown) {
    if (this.aborted) return
    this.aborted = true
    this.reason = reason ?? new WebAbortReason()
    const event = Object.freeze({ type: 'abort' as const })
    this.onabort?.(event)
    for (const listener of [...this.listeners]) listener(event)
    this.listeners.clear()
  }
}

export class WebAbortController {
  readonly signal = new WebAbortSignal()

  abort(reason?: unknown) {
    this.signal.dispatchAbort(reason)
  }
}

export const DEFAULT_ABORT_CONSTRUCTORS = Object.freeze({
  AbortController: WebAbortController as unknown as typeof globalThis.AbortController,
  AbortSignal: WebAbortSignal as unknown as typeof globalThis.AbortSignal
})
