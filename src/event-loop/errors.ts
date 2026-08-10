export type HolonomyRuntimeErrorCode =
  | 'ERR_HOLONOMY_CALLBACK_FAILED'
  | 'ERR_HOLONOMY_CLOCK_NOT_MONOTONIC'
  | 'ERR_HOLONOMY_DISPOSED'
  | 'ERR_HOLONOMY_INVALID_OPTION'
  | 'ERR_HOLONOMY_MICROTASK_CHECKPOINT_FAILED'
  | 'ERR_HOLONOMY_NATIVE_REQUEST_NOT_PENDING'
  | 'ERR_HOLONOMY_TASK_BUDGET_EXCEEDED'
  | 'ERR_HOLONOMY_TURN_REENTRANT'
  | 'ERR_HOLONOMY_WAKEUP_FAILED'

export class HolonomyRuntimeError extends Error {
  readonly code: HolonomyRuntimeErrorCode

  constructor(code: HolonomyRuntimeErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'HolonomyRuntimeError'
  }
}

export class EventLoopDisposedError extends HolonomyRuntimeError {
  constructor() {
    super(
      'ERR_HOLONOMY_DISPOSED',
      'The Holonomy Runtime event loop has been disposed'
    )
    this.name = 'EventLoopDisposedError'
  }
}

export class EventLoopBudgetExceededError extends HolonomyRuntimeError {
  readonly budget: number

  constructor(budget: number) {
    super(
      'ERR_HOLONOMY_TASK_BUDGET_EXCEEDED',
      `The Holonomy Runtime callback budget of ${budget} was exhausted`
    )
    this.budget = budget
    this.name = 'EventLoopBudgetExceededError'
  }
}

export class EventLoopClockError extends HolonomyRuntimeError {
  readonly currentMs: number
  readonly previousMs: number | undefined

  constructor(previousMs: number | undefined, currentMs: number) {
    const message = !Number.isFinite(currentMs) || currentMs < 0
      ? `The host clock returned an invalid monotonic timestamp: ${String(currentMs)}`
      : `The host clock moved backwards from ${String(previousMs)}ms to ${currentMs}ms`
    super('ERR_HOLONOMY_CLOCK_NOT_MONOTONIC', message)
    this.currentMs = currentMs
    this.previousMs = previousMs
    this.name = 'EventLoopClockError'
  }
}

export class EventLoopCallbackError extends HolonomyRuntimeError {
  readonly cause: unknown

  constructor(cause: unknown) {
    super(
      'ERR_HOLONOMY_CALLBACK_FAILED',
      'A Holonomy Runtime event-loop callback failed'
    )
    this.cause = cause
    this.name = 'EventLoopCallbackError'
  }
}

export class EventLoopMicrotaskCheckpointError extends HolonomyRuntimeError {
  readonly cause: unknown

  constructor(cause: unknown) {
    super(
      'ERR_HOLONOMY_MICROTASK_CHECKPOINT_FAILED',
      'The host Promise microtask checkpoint failed'
    )
    this.cause = cause
    this.name = 'EventLoopMicrotaskCheckpointError'
  }
}

export class EventLoopWakeupError extends HolonomyRuntimeError {
  readonly cause: unknown

  constructor(cause: unknown) {
    super(
      'ERR_HOLONOMY_WAKEUP_FAILED',
      'The host event-loop wakeup request failed'
    )
    this.cause = cause
    this.name = 'EventLoopWakeupError'
  }
}

export class EventLoopNativeRequestNotPendingError extends HolonomyRuntimeError {
  readonly requestId: string

  constructor(requestId: string) {
    super(
      'ERR_HOLONOMY_NATIVE_REQUEST_NOT_PENDING',
      'The native request is not pending'
    )
    this.requestId = requestId
    this.name = 'EventLoopNativeRequestNotPendingError'
  }
}

export class EventLoopReentrantTurnError extends HolonomyRuntimeError {
  constructor() {
    super(
      'ERR_HOLONOMY_TURN_REENTRANT',
      'The Holonomy Runtime event loop cannot run a reentrant turn'
    )
    this.name = 'EventLoopReentrantTurnError'
  }
}

export class EventLoopOptionError extends HolonomyRuntimeError {
  constructor(name: string, value: unknown) {
    super(
      'ERR_HOLONOMY_INVALID_OPTION',
      `Invalid Holonomy Runtime event-loop option ${name}: ${String(value)}`
    )
    this.name = 'EventLoopOptionError'
  }
}
