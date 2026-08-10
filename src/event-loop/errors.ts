export type MobileRuntimeErrorCode =
  | 'ERR_MOBILE_RUNTIME_CALLBACK_FAILED'
  | 'ERR_MOBILE_RUNTIME_CLOCK_NOT_MONOTONIC'
  | 'ERR_MOBILE_RUNTIME_DISPOSED'
  | 'ERR_MOBILE_RUNTIME_INVALID_OPTION'
  | 'ERR_MOBILE_RUNTIME_MICROTASK_CHECKPOINT_FAILED'
  | 'ERR_MOBILE_RUNTIME_NATIVE_REQUEST_NOT_PENDING'
  | 'ERR_MOBILE_RUNTIME_TASK_BUDGET_EXCEEDED'
  | 'ERR_MOBILE_RUNTIME_TURN_REENTRANT'
  | 'ERR_MOBILE_RUNTIME_WAKEUP_FAILED'

export class MobileRuntimeError extends Error {
  readonly code: MobileRuntimeErrorCode

  constructor(code: MobileRuntimeErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'MobileRuntimeError'
  }
}

export class EventLoopDisposedError extends MobileRuntimeError {
  constructor() {
    super(
      'ERR_MOBILE_RUNTIME_DISPOSED',
      'The mobile runtime event loop has been disposed'
    )
    this.name = 'EventLoopDisposedError'
  }
}

export class EventLoopBudgetExceededError extends MobileRuntimeError {
  readonly budget: number

  constructor(budget: number) {
    super(
      'ERR_MOBILE_RUNTIME_TASK_BUDGET_EXCEEDED',
      `The mobile runtime callback budget of ${budget} was exhausted`
    )
    this.budget = budget
    this.name = 'EventLoopBudgetExceededError'
  }
}

export class EventLoopClockError extends MobileRuntimeError {
  readonly currentMs: number
  readonly previousMs: number | undefined

  constructor(previousMs: number | undefined, currentMs: number) {
    const message = !Number.isFinite(currentMs) || currentMs < 0
      ? `The host clock returned an invalid monotonic timestamp: ${String(currentMs)}`
      : `The host clock moved backwards from ${String(previousMs)}ms to ${currentMs}ms`
    super('ERR_MOBILE_RUNTIME_CLOCK_NOT_MONOTONIC', message)
    this.currentMs = currentMs
    this.previousMs = previousMs
    this.name = 'EventLoopClockError'
  }
}

export class EventLoopCallbackError extends MobileRuntimeError {
  readonly cause: unknown

  constructor(cause: unknown) {
    super(
      'ERR_MOBILE_RUNTIME_CALLBACK_FAILED',
      'A mobile runtime event-loop callback failed'
    )
    this.cause = cause
    this.name = 'EventLoopCallbackError'
  }
}

export class EventLoopMicrotaskCheckpointError extends MobileRuntimeError {
  readonly cause: unknown

  constructor(cause: unknown) {
    super(
      'ERR_MOBILE_RUNTIME_MICROTASK_CHECKPOINT_FAILED',
      'The host Promise microtask checkpoint failed'
    )
    this.cause = cause
    this.name = 'EventLoopMicrotaskCheckpointError'
  }
}

export class EventLoopWakeupError extends MobileRuntimeError {
  readonly cause: unknown

  constructor(cause: unknown) {
    super(
      'ERR_MOBILE_RUNTIME_WAKEUP_FAILED',
      'The host event-loop wakeup request failed'
    )
    this.cause = cause
    this.name = 'EventLoopWakeupError'
  }
}

export class EventLoopNativeRequestNotPendingError extends MobileRuntimeError {
  readonly requestId: string

  constructor(requestId: string) {
    super(
      'ERR_MOBILE_RUNTIME_NATIVE_REQUEST_NOT_PENDING',
      'The native request is not pending'
    )
    this.requestId = requestId
    this.name = 'EventLoopNativeRequestNotPendingError'
  }
}

export class EventLoopReentrantTurnError extends MobileRuntimeError {
  constructor() {
    super(
      'ERR_MOBILE_RUNTIME_TURN_REENTRANT',
      'The mobile runtime event loop cannot run a reentrant turn'
    )
    this.name = 'EventLoopReentrantTurnError'
  }
}

export class EventLoopOptionError extends MobileRuntimeError {
  constructor(name: string, value: unknown) {
    super(
      'ERR_MOBILE_RUNTIME_INVALID_OPTION',
      `Invalid mobile runtime event-loop option ${name}: ${String(value)}`
    )
    this.name = 'EventLoopOptionError'
  }
}
