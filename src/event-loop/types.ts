export type EventLoopCallback = () => void

export type EventLoopTaskId = number

export type EventLoopTimerId = number

export type EventLoopTaskKind =
  | 'macrotask'
  | 'native-completion'
  | 'next-tick'
  | 'timer'

export type HostEventLoopTermination =
  | {
    code: 'ERR_MOBILE_RUNTIME_SHUTDOWN'
    kind: 'shutdown'
  }
  | {
    code: string
    error: unknown
    kind: 'error'
  }

export interface HostEventLoopPort {
  /** Returns monotonic milliseconds. */
  now(): number

  /**
   * Arms the next host wakeup at an absolute monotonic deadline. `null`
   * cancels a previously armed wakeup.
   */
  requestWakeup(deadlineMs: number | null): void

  /** Runs the engine-owned Promise microtask checkpoint to completion. */
  checkpointMicrotasks(): void

  /** Terminates the platform runtime after shutdown or a fatal loop error. */
  terminate(reason: HostEventLoopTermination): void
}

export interface RuntimeEventLoopOptions {
  maxCallbacksPerTurn?: number
  maxTimerDelayMs?: number
  minimumIntervalMs?: number
}

export interface EventLoopTaskOptions {
  ref?: boolean
}

export interface EventLoopTimerOptions {
  ref?: boolean
}

export interface SetTimerOptions extends EventLoopTimerOptions {
  intervalMs?: number
}

export interface NativeRequestOptions {
  ref?: boolean
}

export type EventLoopLifecycleObserver = (
  reason: HostEventLoopTermination
) => void

export type EventLoopLifecycleSubscription = () => boolean

export interface EventLoopSnapshot {
  hasPendingWork: boolean
  isAlive: boolean
  nextWakeupAt: number | null
}

export interface RunTurnResult extends EventLoopSnapshot {
  callbacksProcessed: number
  status: 'idle' | 'ran' | 'shutdown'
  taskKind: EventLoopTaskKind | null
}
