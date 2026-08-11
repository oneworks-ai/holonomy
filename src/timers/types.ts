export type RuntimeTimerCallback = (...args: unknown[]) => void

export interface RuntimeTimerHostPort {
  /** Schedules one native monotonic timer and returns a positive process-local identifier. */
  schedule(delayMs: number, intervalMs?: number): number
  cancel(timerId: number): boolean | void
}

export interface RuntimeTimerGlobals {
  clearInterval(timerId: number): void
  clearTimeout(timerId: number): void
  setInterval(callback: RuntimeTimerCallback, intervalMs?: number, ...args: unknown[]): number
  setTimeout(callback: RuntimeTimerCallback, delayMs?: number, ...args: unknown[]): number
}

export interface RuntimeTimers extends RuntimeTimerGlobals {
  /** Host-only delivery hook. Native schedulers deliver due identifiers on the runtime thread. */
  fire(timerId: number): boolean
  dispose(): void
  readonly globals: Readonly<RuntimeTimerGlobals>
  readonly syntheticModule: Readonly<RuntimeTimerGlobals>
}
