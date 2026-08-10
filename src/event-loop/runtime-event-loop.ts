/* eslint-disable max-lines -- event-loop transitions keep scheduling state and fatal cleanup in one owner. */

import {
  EventLoopBudgetExceededError,
  EventLoopCallbackError,
  EventLoopClockError,
  EventLoopDisposedError,
  EventLoopMicrotaskCheckpointError,
  EventLoopNativeRequestNotPendingError,
  EventLoopOptionError,
  EventLoopReentrantTurnError,
  EventLoopWakeupError,
  MobileRuntimeError
} from './errors.js'
import type {
  EventLoopCallback,
  EventLoopLifecycleObserver,
  EventLoopLifecycleSubscription,
  EventLoopSnapshot,
  EventLoopTaskId,
  EventLoopTaskKind,
  EventLoopTaskOptions,
  EventLoopTimerId,
  EventLoopTimerOptions,
  HostEventLoopPort,
  HostEventLoopTermination,
  NativeRequestOptions,
  RunTurnResult,
  RuntimeEventLoopOptions,
  SetTimerOptions
} from './types.js'

const DEFAULT_MAX_CALLBACKS_PER_TURN = 1_024
const DEFAULT_MAX_TIMER_DELAY_MS = 2_147_483_647
const DEFAULT_MINIMUM_INTERVAL_MS = 1

interface ReadyTask {
  callback: EventLoopCallback
  id: EventLoopTaskId
  kind: 'macrotask' | 'native-completion'
  nativeRequestId?: string
  readyAt: number
  ref: boolean
  sequence: number
}

interface NextTickTask {
  callback: EventLoopCallback
  id: EventLoopTaskId
  ref: boolean
}

interface TimerRecord {
  callback: EventLoopCallback
  dueAt: number
  id: EventLoopTimerId
  intervalMs: number | null
  kind: 'timer'
  ref: boolean
  sequence: number
}

interface NativeRequestRecord {
  ref: boolean
}

interface ResolvedOptions {
  maxCallbacksPerTurn: number
  maxTimerDelayMs: number
  minimumIntervalMs: number
}

interface TurnCounter {
  callbacks: number
}

const readPositiveInteger = (
  name: string,
  value: number | undefined,
  fallback: number
) => {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new EventLoopOptionError(name, resolved)
  }
  return resolved
}

const assertCallback = (callback: EventLoopCallback) => {
  if (typeof callback !== 'function') {
    throw new EventLoopOptionError('callback', callback)
  }
}

export class RuntimeEventLoop {
  private readonly lifecycleObservers = new Set<EventLoopLifecycleObserver>()
  private readonly nativeRequests = new Map<string, NativeRequestRecord>()
  private readonly nextTicks: NextTickTask[] = []
  private readonly options: ResolvedOptions
  private readonly readyTasks: ReadyTask[] = []
  private readonly tasksById = new Map<EventLoopTaskId, ReadyTask | NextTickTask>()
  private readonly timers = new Map<EventLoopTimerId, TimerRecord>()
  private disposed = false
  private lastNow: number | undefined
  private nextId = 1
  private nextSequence = 1
  private runningTurn = false
  private scheduledWakeupAt: number | null | undefined

  constructor(
    private readonly port: HostEventLoopPort,
    options: RuntimeEventLoopOptions = {}
  ) {
    const maxTimerDelayMs = readPositiveInteger(
      'maxTimerDelayMs',
      options.maxTimerDelayMs,
      DEFAULT_MAX_TIMER_DELAY_MS
    )
    const minimumIntervalMs = readPositiveInteger(
      'minimumIntervalMs',
      options.minimumIntervalMs,
      DEFAULT_MINIMUM_INTERVAL_MS
    )
    if (minimumIntervalMs > maxTimerDelayMs) {
      throw new EventLoopOptionError('minimumIntervalMs', minimumIntervalMs)
    }
    this.options = {
      maxCallbacksPerTurn: readPositiveInteger(
        'maxCallbacksPerTurn',
        options.maxCallbacksPerTurn,
        DEFAULT_MAX_CALLBACKS_PER_TURN
      ),
      maxTimerDelayMs,
      minimumIntervalMs
    }
  }

  get isDisposed() {
    return this.disposed
  }

  /**
   * Reads the loop's monotonic clock through the same fatal clock validation
   * used by turns and timers. Runtime subsystems use this to translate an
   * absolute deadline before arming a timer owned by this loop.
   */
  getCurrentTime(): number {
    this.assertAcceptingWork()
    return this.readNow()
  }

  addLifecycleObserver(
    observer: EventLoopLifecycleObserver
  ): EventLoopLifecycleSubscription {
    this.assertAcceptingWork()
    if (typeof observer !== 'function') {
      throw new EventLoopOptionError('observer', observer)
    }
    this.lifecycleObservers.add(observer)
    return () => this.lifecycleObservers.delete(observer)
  }

  enqueueMacrotask(
    callback: EventLoopCallback,
    options: EventLoopTaskOptions = {}
  ): EventLoopTaskId {
    return this.enqueueReadyTask('macrotask', callback, options.ref ?? true)
  }

  enqueueNextTick(
    callback: EventLoopCallback,
    options: EventLoopTaskOptions = {}
  ): EventLoopTaskId {
    this.assertAcceptingWork()
    assertCallback(callback)
    const now = this.readNow()
    const task: NextTickTask = {
      callback,
      id: this.allocateId(),
      ref: options.ref ?? true
    }
    this.nextTicks.push(task)
    this.tasksById.set(task.id, task)
    this.commitWakeupAdmission(now, () => {
      this.tasksById.delete(task.id)
      const index = this.nextTicks.indexOf(task)
      if (index >= 0) this.nextTicks.splice(index, 1)
    })
    return task.id
  }

  cancelTask(taskId: EventLoopTaskId): boolean {
    const task = this.tasksById.get(taskId)
    if (!task) {
      return false
    }
    this.tasksById.delete(taskId)
    if ('kind' in task) {
      const index = this.readyTasks.indexOf(task)
      if (index >= 0) {
        this.readyTasks.splice(index, 1)
      }
    } else {
      const index = this.nextTicks.indexOf(task)
      if (index >= 0) {
        this.nextTicks.splice(index, 1)
      }
    }
    this.reconcileWakeupIfActive()
    return true
  }

  setTimer(
    callback: EventLoopCallback,
    delayMs: number,
    options: SetTimerOptions = {}
  ): EventLoopTimerId {
    this.assertAcceptingWork()
    assertCallback(callback)
    const now = this.readNow()
    const normalizedDelay = this.normalizeDelay('delayMs', delayMs, true)
    const intervalMs = options.intervalMs === undefined
      ? null
      : this.normalizeDelay('intervalMs', options.intervalMs, false)
    const timer: TimerRecord = {
      callback,
      dueAt: now + normalizedDelay,
      id: this.allocateId(),
      intervalMs,
      kind: 'timer',
      ref: options.ref ?? true,
      sequence: this.allocateSequence()
    }
    this.timers.set(timer.id, timer)
    this.commitWakeupAdmission(now, () => {
      this.timers.delete(timer.id)
    })
    return timer.id
  }

  setTimeout(
    callback: EventLoopCallback,
    delayMs = 0,
    options: EventLoopTimerOptions = {}
  ): EventLoopTimerId {
    return this.setTimer(callback, delayMs, options)
  }

  setInterval(
    callback: EventLoopCallback,
    intervalMs: number,
    options: EventLoopTimerOptions = {}
  ): EventLoopTimerId {
    return this.setTimer(callback, intervalMs, {
      ...options,
      intervalMs
    })
  }

  clearTimer(timerId: EventLoopTimerId): boolean {
    const cleared = this.timers.delete(timerId)
    if (cleared) {
      this.reconcileWakeupIfActive()
    }
    return cleared
  }

  clearTimeout(timerId: EventLoopTimerId): boolean {
    return this.clearTimer(timerId)
  }

  clearInterval(timerId: EventLoopTimerId): boolean {
    return this.clearTimer(timerId)
  }

  refTimer(timerId: EventLoopTimerId): boolean {
    return this.setTimerRef(timerId, true)
  }

  unrefTimer(timerId: EventLoopTimerId): boolean {
    return this.setTimerRef(timerId, false)
  }

  hasRefTimer(timerId: EventLoopTimerId): boolean {
    return this.timers.get(timerId)?.ref ?? false
  }

  registerNativeRequest(
    requestId: string,
    options: NativeRequestOptions = {}
  ): void {
    this.assertAcceptingWork()
    this.assertRequestId(requestId)
    if (this.nativeRequests.has(requestId)) {
      throw new EventLoopOptionError('requestId', requestId)
    }
    const now = this.readNow()
    const request = { ref: options.ref ?? true }
    this.nativeRequests.set(requestId, request)
    this.commitWakeupAdmission(now, () => {
      if (this.nativeRequests.get(requestId) === request) {
        this.nativeRequests.delete(requestId)
      }
    })
  }

  completeNativeRequest(
    requestId: string,
    callback: EventLoopCallback,
    options: NativeRequestOptions = {}
  ): EventLoopTaskId {
    this.assertAcceptingWork()
    this.assertRequestId(requestId)
    assertCallback(callback)
    const pending = this.nativeRequests.get(requestId)
    if (!pending) {
      throw new EventLoopNativeRequestNotPendingError(requestId)
    }
    const now = this.readNow()
    if (!this.nativeRequests.delete(requestId)) {
      throw new EventLoopNativeRequestNotPendingError(requestId)
    }
    return this.enqueueReadyTaskAt(
      'native-completion',
      callback,
      options.ref ?? pending.ref,
      now,
      requestId
    )
  }

  cancelNativeRequest(requestId: string): boolean {
    let canceled = this.nativeRequests.delete(requestId)
    for (let index = this.readyTasks.length - 1; index >= 0; index -= 1) {
      const task = this.readyTasks[index]
      if (
        task?.kind === 'native-completion' &&
        task.nativeRequestId === requestId &&
        this.tasksById.delete(task.id)
      ) {
        this.readyTasks.splice(index, 1)
        canceled = true
      }
    }
    if (canceled) {
      this.reconcileWakeupIfActive()
    }
    return canceled
  }

  refNativeRequest(requestId: string): boolean {
    return this.setNativeRequestRef(requestId, true)
  }

  unrefNativeRequest(requestId: string): boolean {
    return this.setNativeRequestRef(requestId, false)
  }

  getSnapshot(): EventLoopSnapshot {
    if (this.disposed) {
      return {
        hasPendingWork: false,
        isAlive: false,
        nextWakeupAt: null
      }
    }
    const now = this.readNow()
    return this.createSnapshot(now)
  }

  runTurn(): RunTurnResult {
    if (this.disposed) {
      return this.createShutdownResult(0, null)
    }
    if (this.runningTurn) {
      throw new EventLoopReentrantTurnError()
    }

    this.runningTurn = true
    try {
      return this.runActiveTurn()
    } finally {
      this.runningTurn = false
    }
  }

  shutdown(): void {
    if (this.disposed) {
      return
    }
    this.finalizeTermination({
      code: 'ERR_MOBILE_RUNTIME_SHUTDOWN',
      kind: 'shutdown'
    })
  }

  dispose(): void {
    this.shutdown()
  }

  private advanceIntervalDeadline(timer: TimerRecord, now: number) {
    if (
      timer.intervalMs === null ||
      this.timers.get(timer.id) !== timer ||
      timer.dueAt > now
    ) {
      return
    }
    const elapsed = Math.max(0, now - timer.dueAt)
    const intervalsToSkip = Math.floor(elapsed / timer.intervalMs)
    timer.dueAt += (intervalsToSkip + 1) * timer.intervalMs
  }

  private allocateId() {
    return this.nextId++
  }

  private allocateSequence() {
    return this.nextSequence++
  }

  private assertAcceptingWork() {
    if (this.disposed) {
      throw new EventLoopDisposedError()
    }
  }

  private assertRequestId(requestId: string) {
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new EventLoopOptionError('requestId', requestId)
    }
  }

  private checkpointMicrotasks() {
    try {
      this.port.checkpointMicrotasks()
    } catch (error) {
      return this.fail(new EventLoopMicrotaskCheckpointError(error))
    }
  }

  private clearPendingWork() {
    this.nativeRequests.clear()
    this.nextTicks.length = 0
    this.readyTasks.length = 0
    this.tasksById.clear()
    this.timers.clear()
  }

  private commitWakeupAdmission(now: number, rollback: () => void) {
    try {
      this.reconcileWakeupAt(now)
    } catch (error) {
      rollback()
      return this.fail(this.normalizeWakeupError(error))
    }
  }

  private createShutdownResult(
    callbacksProcessed: number,
    taskKind: EventLoopTaskKind | null
  ): RunTurnResult {
    return {
      callbacksProcessed,
      hasPendingWork: false,
      isAlive: false,
      nextWakeupAt: null,
      status: 'shutdown',
      taskKind
    }
  }

  private createSnapshot(now: number): EventLoopSnapshot {
    const readyTasks = this.activeReadyTasks()
    const nextTicks = this.activeNextTicks()
    const timers = Array.from(this.timers.values())
    const isAlive = nextTicks.some((task) => task.ref) ||
      readyTasks.some((task) => task.ref) ||
      timers.some((timer) => timer.ref) ||
      Array.from(this.nativeRequests.values()).some((request) => request.ref)
    const hasPendingWork = nextTicks.length > 0 ||
      readyTasks.length > 0 ||
      timers.length > 0 ||
      this.nativeRequests.size > 0

    let nextWakeupAt: number | null = null
    if (isAlive) {
      if (nextTicks.length > 0 || readyTasks.length > 0) {
        nextWakeupAt = now
      }
      for (const timer of timers) {
        if (nextWakeupAt === null || timer.dueAt < nextWakeupAt) {
          nextWakeupAt = Math.max(now, timer.dueAt)
        }
      }
    }

    return { hasPendingWork, isAlive, nextWakeupAt }
  }

  private drainNextTicks(counter: TurnCounter) {
    while (!this.disposed) {
      const task = this.takeNextTick()
      if (!task) {
        return
      }
      this.executeCallback(task.callback, counter)
    }
  }

  private enqueueReadyTask(
    kind: ReadyTask['kind'],
    callback: EventLoopCallback,
    ref: boolean,
    nativeRequestId?: string
  ) {
    this.assertAcceptingWork()
    assertCallback(callback)
    const now = this.readNow()
    return this.enqueueReadyTaskAt(kind, callback, ref, now, nativeRequestId)
  }

  private enqueueReadyTaskAt(
    kind: ReadyTask['kind'],
    callback: EventLoopCallback,
    ref: boolean,
    readyAt: number,
    nativeRequestId?: string
  ) {
    const task: ReadyTask = {
      callback,
      id: this.allocateId(),
      kind,
      nativeRequestId,
      readyAt,
      ref,
      sequence: this.allocateSequence()
    }
    this.readyTasks.push(task)
    this.tasksById.set(task.id, task)
    this.commitWakeupAdmission(readyAt, () => {
      this.tasksById.delete(task.id)
      const index = this.readyTasks.indexOf(task)
      if (index >= 0) this.readyTasks.splice(index, 1)
    })
    return task.id
  }

  private executeCallback(callback: EventLoopCallback, counter: TurnCounter) {
    if (counter.callbacks >= this.options.maxCallbacksPerTurn) {
      return this.fail(
        new EventLoopBudgetExceededError(
          this.options.maxCallbacksPerTurn
        )
      )
    }
    counter.callbacks += 1
    try {
      callback()
    } catch (error) {
      if (this.disposed) {
        throw error instanceof MobileRuntimeError
          ? error
          : new EventLoopCallbackError(error)
      }
      if (error instanceof MobileRuntimeError) {
        return this.fail(error)
      }
      return this.fail(new EventLoopCallbackError(error))
    }
  }

  private fail(error: MobileRuntimeError): never {
    this.finalizeTermination({ code: error.code, error, kind: 'error' })
    throw error
  }

  private finalizeTermination(reason: HostEventLoopTermination) {
    if (this.disposed) return
    this.disposed = true
    this.clearPendingWork()
    try {
      this.requestWakeup(null)
    } catch {
      // Termination and lifecycle cleanup must not depend on host wakeup order.
      this.scheduledWakeupAt = null
    }
    const observers = [...this.lifecycleObservers]
    this.lifecycleObservers.clear()
    for (const observer of observers) {
      try {
        observer(reason)
      } catch {
        // One subsystem cannot block termination of the others.
      }
    }
    try {
      this.port.terminate(reason)
    } catch {
      // The loop is already terminal and all observers have been notified.
    }
  }

  private hasRunnableNextTick() {
    return this.nextTicks.some((task) => this.tasksById.has(task.id))
  }

  private activeNextTicks() {
    return this.nextTicks.filter((task) => this.tasksById.has(task.id))
  }

  private activeReadyTasks() {
    return this.readyTasks.filter((task) => this.tasksById.has(task.id))
  }

  private normalizeDelay(name: string, value: number, allowZero: boolean) {
    if (!Number.isFinite(value) || value < 0) {
      throw new EventLoopOptionError(name, value)
    }
    const minimum = allowZero ? 0 : this.options.minimumIntervalMs
    return Math.min(
      this.options.maxTimerDelayMs,
      Math.max(minimum, Math.ceil(value))
    )
  }

  private readNow() {
    const now = this.port.now()
    if (!Number.isFinite(now) || now < 0) {
      return this.fail(new EventLoopClockError(this.lastNow, now))
    }
    if (this.lastNow !== undefined && now < this.lastNow) {
      return this.fail(new EventLoopClockError(this.lastNow, now))
    }
    this.lastNow = now
    return now
  }

  private reconcileWakeupAt(now: number) {
    const snapshot = this.createSnapshot(now)
    this.requestWakeup(snapshot.nextWakeupAt)
  }

  private reconcileWakeupIfActive() {
    if (!this.disposed) {
      try {
        this.reconcileWakeupAt(this.readNow())
      } catch (error) {
        this.fail(this.normalizeWakeupError(error))
      }
    }
  }

  private requestWakeup(deadlineMs: number | null) {
    if (this.scheduledWakeupAt === deadlineMs) {
      return
    }
    try {
      this.port.requestWakeup(deadlineMs)
    } catch (error) {
      throw new EventLoopWakeupError(error)
    }
    this.scheduledWakeupAt = deadlineMs
  }

  private normalizeWakeupError(error: unknown) {
    return error instanceof MobileRuntimeError
      ? error
      : new EventLoopWakeupError(error)
  }

  private runActiveTurn(): RunTurnResult {
    const now = this.readNow()
    const counter: TurnCounter = { callbacks: 0 }
    let selectedTask: ReadyTask | TimerRecord | undefined
    let taskKind: EventLoopTaskKind | null = null

    // The host wakeup that entered this turn has been consumed. The loop will
    // arm another one after it observes the resulting state.
    this.scheduledWakeupAt = undefined

    if (this.hasRunnableNextTick()) {
      taskKind = 'next-tick'
      this.drainNextTicks(counter)
    } else {
      selectedTask = this.takeReadyTask(now)
      if (selectedTask) {
        taskKind = selectedTask.kind
        this.executeCallback(selectedTask.callback, counter)
        if (this.disposed) {
          return this.createShutdownResult(counter.callbacks, taskKind)
        }
        if (selectedTask.kind === 'timer') {
          this.advanceIntervalDeadline(selectedTask, this.readNow())
        }
        this.drainNextTicks(counter)
      }
    }

    if (this.disposed) {
      return this.createShutdownResult(counter.callbacks, taskKind)
    }

    if (taskKind) {
      this.checkpointMicrotasks()
    }

    if (this.disposed) {
      return this.createShutdownResult(counter.callbacks, taskKind)
    }

    const finishedAt = this.readNow()
    if (selectedTask?.kind === 'timer') {
      this.advanceIntervalDeadline(selectedTask, finishedAt)
    }
    const snapshot = this.createSnapshot(finishedAt)
    try {
      this.requestWakeup(snapshot.nextWakeupAt)
    } catch (error) {
      this.fail(this.normalizeWakeupError(error))
    }
    return {
      ...snapshot,
      callbacksProcessed: counter.callbacks,
      status: taskKind ? 'ran' : 'idle',
      taskKind
    }
  }

  private setNativeRequestRef(requestId: string, ref: boolean) {
    const request = this.nativeRequests.get(requestId)
    if (!request || request.ref === ref) {
      return Boolean(request)
    }
    request.ref = ref
    this.reconcileWakeupIfActive()
    return true
  }

  private setTimerRef(timerId: EventLoopTimerId, ref: boolean) {
    const timer = this.timers.get(timerId)
    if (!timer || timer.ref === ref) {
      return Boolean(timer)
    }
    timer.ref = ref
    this.reconcileWakeupIfActive()
    return true
  }

  private takeNextTick() {
    while (this.nextTicks.length > 0) {
      const task = this.nextTicks.shift()
      if (task && this.tasksById.delete(task.id)) {
        return task
      }
    }
    return undefined
  }

  private takeReadyTask(now: number): ReadyTask | TimerRecord | undefined {
    let readyTask: ReadyTask | undefined
    let readyTaskIndex = -1
    for (let index = 0; index < this.readyTasks.length; index += 1) {
      const task = this.readyTasks[index]
      if (!task) {
        continue
      }
      if (!this.tasksById.has(task.id)) {
        continue
      }
      if (
        !readyTask ||
        task.readyAt < readyTask.readyAt ||
        (
          task.readyAt === readyTask.readyAt &&
          task.sequence < readyTask.sequence
        )
      ) {
        readyTask = task
        readyTaskIndex = index
      }
    }

    let dueTimer: TimerRecord | undefined
    for (const timer of this.timers.values()) {
      if (timer.dueAt > now) {
        continue
      }
      if (
        !dueTimer ||
        timer.dueAt < dueTimer.dueAt ||
        (
          timer.dueAt === dueTimer.dueAt &&
          timer.sequence < dueTimer.sequence
        )
      ) {
        dueTimer = timer
      }
    }

    if (
      readyTask &&
      (
        !dueTimer ||
        readyTask.readyAt < dueTimer.dueAt ||
        (
          readyTask.readyAt === dueTimer.dueAt &&
          readyTask.sequence < dueTimer.sequence
        )
      )
    ) {
      this.tasksById.delete(readyTask.id)
      this.readyTasks.splice(readyTaskIndex, 1)
      return readyTask
    }
    if (!dueTimer) {
      return undefined
    }

    if (dueTimer.intervalMs === null) {
      this.timers.delete(dueTimer.id)
    }
    return dueTimer
  }
}

export const createRuntimeEventLoop = (
  port: HostEventLoopPort,
  options?: RuntimeEventLoopOptions
) => new RuntimeEventLoop(port, options)
