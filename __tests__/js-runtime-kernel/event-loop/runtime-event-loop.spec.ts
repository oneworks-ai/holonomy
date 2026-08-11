import { describe, expect, it } from 'vitest'

import {
  EventLoopBudgetExceededError,
  EventLoopClockError,
  EventLoopDisposedError,
  EventLoopNativeRequestNotPendingError,
  EventLoopReentrantTurnError,
  EventLoopWakeupError,
  RuntimeEventLoop
} from '../../../src/index.js'
import type { EventLoopCallback, HostEventLoopPort, HostEventLoopTermination } from '../../../src/index.js'

class VirtualHostEventLoopPort implements HostEventLoopPort {
  readonly terminations: HostEventLoopTermination[] = []
  readonly wakeups: Array<number | null> = []
  checkpointCount = 0
  throwOnWakeup = false
  private readonly promiseReactions: EventLoopCallback[] = []
  private nowMs = 0

  now() {
    return this.nowMs
  }

  requestWakeup(deadlineMs: number | null) {
    if (this.throwOnWakeup) throw new Error('wakeup failed')
    this.wakeups.push(deadlineMs)
  }

  checkpointMicrotasks(): void {
    this.checkpointCount += 1
    while (true) {
      const reaction = this.promiseReactions.shift()
      if (!reaction) {
        return
      }
      reaction()
    }
  }

  terminate(reason: HostEventLoopTermination) {
    this.terminations.push(reason)
  }

  advanceTo(nowMs: number) {
    this.nowMs = nowMs
  }

  queuePromiseReaction(callback: EventLoopCallback) {
    this.promiseReactions.push(callback)
  }
}

describe('runtime event loop', () => {
  it('runs one macrotask, drains nested next ticks, then checkpoints Promise reactions', () => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)
    const events: string[] = []

    loop.enqueueMacrotask(() => {
      events.push('macro:outer')
      loop.enqueueMacrotask(() => events.push('macro:nested'))
      loop.enqueueNextTick(() => events.push('next-tick'))
      host.queuePromiseReaction(() => events.push('promise'))
    })

    expect(loop.runTurn()).toMatchObject({
      callbacksProcessed: 2,
      status: 'ran',
      taskKind: 'macrotask'
    })
    expect(host.checkpointCount).toBe(1)
    expect(events).toEqual(['macro:outer', 'next-tick', 'promise'])

    loop.runTurn()
    expect(host.checkpointCount).toBe(2)
    expect(events).toEqual([
      'macro:outer',
      'next-tick',
      'promise',
      'macro:nested'
    ])
  })

  it('drains a pre-existing next-tick phase before selecting a macrotask', () => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)
    const events: string[] = []

    loop.enqueueMacrotask(() => events.push('macro'))
    loop.enqueueNextTick(() => {
      events.push('tick:outer')
      loop.enqueueNextTick(() => events.push('tick:nested'))
    })
    host.queuePromiseReaction(() => events.push('promise'))

    expect(loop.runTurn().taskKind).toBe('next-tick')
    expect(events).toEqual(['tick:outer', 'tick:nested', 'promise'])

    expect(loop.runTurn().taskKind).toBe('macrotask')
    expect(events).toEqual(['tick:outer', 'tick:nested', 'promise', 'macro'])
  })

  it('uses virtual monotonic time and supports timeout and task cancellation', () => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)
    const events: string[] = []

    const canceledTask = loop.enqueueMacrotask(() => events.push('task'))
    expect(loop.cancelTask(canceledTask)).toBe(true)
    expect(loop.cancelTask(canceledTask)).toBe(false)

    const canceledTimer = loop.setTimeout(() => events.push('timer:5'), 5)
    loop.setTimeout(() => events.push('timer:10'), 10)
    expect(loop.clearTimeout(canceledTimer)).toBe(true)
    expect(loop.clearTimer(canceledTimer)).toBe(false)

    expect(loop.runTurn().status).toBe('idle')
    host.advanceTo(9)
    expect(loop.runTurn().status).toBe('idle')
    host.advanceTo(10)
    expect(loop.runTurn().taskKind).toBe('timer')
    expect(events).toEqual(['timer:10'])
  })

  it.each([
    {
      admit: (loop: RuntimeEventLoop) => loop.registerNativeRequest('request'),
      label: 'native request'
    },
    {
      admit: (loop: RuntimeEventLoop) => loop.setTimer(() => {}, 10),
      label: 'timer'
    },
    {
      admit: (loop: RuntimeEventLoop) => loop.enqueueMacrotask(() => {}),
      label: 'macrotask'
    },
    {
      admit: (loop: RuntimeEventLoop) => loop.enqueueNextTick(() => {}),
      label: 'next tick'
    }
  ])('rolls back $label admission if host wakeup throws', ({ admit }) => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)
    const lifecycle: HostEventLoopTermination[] = []
    loop.addLifecycleObserver(reason => lifecycle.push(reason))
    host.throwOnWakeup = true

    expect(() => admit(loop)).toThrowError(EventLoopWakeupError)
    expect(loop.isDisposed).toBe(true)
    expect(loop.getSnapshot()).toEqual({
      hasPendingWork: false,
      isAlive: false,
      nextWakeupAt: null
    })
    expect(lifecycle).toHaveLength(1)
    expect(host.terminations).toHaveLength(1)
    expect(host.terminations[0]).toMatchObject({
      code: 'ERR_HOLONOMY_WAKEUP_FAILED',
      kind: 'error'
    })
  })

  it('rolls back a native completion task when its wakeup throws', () => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)
    loop.registerNativeRequest('request')
    host.throwOnWakeup = true

    expect(() => loop.completeNativeRequest('request', () => {})).toThrowError(EventLoopWakeupError)
    expect(loop.getSnapshot().hasPendingWork).toBe(false)
    expect(loop.runTurn().callbacksProcessed).toBe(0)
  })

  it('orders ready timers and macrotasks by ready time and insertion order', () => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)
    const events: string[] = []

    loop.setTimeout(() => events.push('timer:first'), 0)
    loop.enqueueMacrotask(() => events.push('macro:second'))
    loop.setTimeout(() => events.push('timer:third'), 0)

    loop.runTurn()
    loop.runTurn()
    loop.runTurn()

    expect(events).toEqual(['timer:first', 'macro:second', 'timer:third'])
  })

  it('uses fixed-rate interval deadlines and skips missed ticks without bursting', () => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)
    const firedAt: number[] = []
    let intervalId = 0

    intervalId = loop.setInterval(() => {
      firedAt.push(host.now())
      if (firedAt.length === 2) {
        loop.clearInterval(intervalId)
      }
    }, 10)

    host.advanceTo(35)
    expect(loop.runTurn()).toMatchObject({ nextWakeupAt: 40, taskKind: 'timer' })
    expect(firedAt).toEqual([35])

    expect(loop.runTurn().status).toBe('idle')
    host.advanceTo(40)
    loop.runTurn()
    expect(firedAt).toEqual([35, 40])
    expect(loop.getSnapshot()).toEqual({
      hasPendingWork: false,
      isAlive: false,
      nextWakeupAt: null
    })
  })

  it('reschedules an interval past time consumed by its callback', () => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)
    const firedAt: number[] = []
    let intervalId = 0

    intervalId = loop.setInterval(() => {
      firedAt.push(host.now())
      if (firedAt.length === 1) {
        host.advanceTo(46)
      } else {
        loop.clearInterval(intervalId)
      }
    }, 10)

    host.advanceTo(10)
    expect(loop.runTurn()).toMatchObject({ nextWakeupAt: 50, taskKind: 'timer' })
    expect(firedAt).toEqual([10])
    expect(loop.runTurn().status).toBe('idle')

    host.advanceTo(50)
    loop.runTurn()
    expect(firedAt).toEqual([10, 50])
  })

  it('keeps liveness separate from opportunistic unreferenced work', () => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)
    const timerId = loop.setTimeout(() => {}, 10)

    expect(loop.unrefTimer(timerId)).toBe(true)
    expect(loop.hasRefTimer(timerId)).toBe(false)
    expect(loop.getSnapshot()).toEqual({
      hasPendingWork: true,
      isAlive: false,
      nextWakeupAt: null
    })

    expect(loop.refTimer(timerId)).toBe(true)
    expect(loop.getSnapshot()).toMatchObject({ isAlive: true, nextWakeupAt: 10 })
    loop.unrefTimer(timerId)

    loop.registerNativeRequest('request:1')
    expect(loop.getSnapshot()).toMatchObject({ isAlive: true, nextWakeupAt: 10 })
    host.advanceTo(10)
    expect(loop.runTurn().taskKind).toBe('timer')
    expect(loop.getSnapshot()).toEqual({
      hasPendingWork: true,
      isAlive: true,
      nextWakeupAt: null
    })

    expect(loop.unrefNativeRequest('request:1')).toBe(true)
    expect(loop.getSnapshot()).toEqual({
      hasPendingWork: true,
      isAlive: false,
      nextWakeupAt: null
    })
  })

  it('queues native completions as macrotasks and allows deterministic cancellation', () => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)
    const events: string[] = []

    loop.registerNativeRequest('canceled')
    loop.completeNativeRequest('canceled', () => events.push('canceled'))
    expect(loop.cancelNativeRequest('canceled')).toBe(true)

    loop.registerNativeRequest('completed')
    loop.completeNativeRequest('completed', () => events.push('completed'))
    expect(loop.runTurn().taskKind).toBe('native-completion')
    expect(events).toEqual(['completed'])
  })

  it('rejects unknown, canceled, late and duplicate native completions', () => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)
    const events: string[] = []

    expect(() =>
      loop.completeNativeRequest(
        'unknown',
        () => events.push('unknown')
      )
    ).toThrowError(EventLoopNativeRequestNotPendingError)

    loop.registerNativeRequest('canceled')
    expect(loop.cancelNativeRequest('canceled')).toBe(true)
    expect(() =>
      loop.completeNativeRequest(
        'canceled',
        () => events.push('late')
      )
    ).toThrowError(EventLoopNativeRequestNotPendingError)

    loop.registerNativeRequest('completed')
    loop.completeNativeRequest('completed', () => events.push('completed'))
    expect(() =>
      loop.completeNativeRequest(
        'completed',
        () => events.push('duplicate')
      )
    ).toThrowError(EventLoopNativeRequestNotPendingError)

    expect(loop.runTurn().taskKind).toBe('native-completion')
    expect(loop.runTurn().status).toBe('idle')
    expect(events).toEqual(['completed'])
  })

  it('makes shutdown idempotent, cancels work and rejects new admissions', () => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)
    loop.setTimeout(() => {}, 10)
    loop.registerNativeRequest('request')

    loop.shutdown()
    loop.dispose()

    expect(host.terminations).toEqual([
      { code: 'ERR_HOLONOMY_SHUTDOWN', kind: 'shutdown' }
    ])
    expect(loop.runTurn()).toMatchObject({
      hasPendingWork: false,
      isAlive: false,
      status: 'shutdown'
    })
    expect(loop.getSnapshot().hasPendingWork).toBe(false)
    expect(() => loop.enqueueMacrotask(() => {})).toThrowError(
      EventLoopDisposedError
    )
    expect(() => loop.setTimeout(() => {}, 0)).toThrowError(
      EventLoopDisposedError
    )
    expect(() => loop.completeNativeRequest('late', () => {})).toThrowError(
      EventLoopDisposedError
    )
  })

  it('stops a turn immediately when its callback shuts the loop down', () => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)
    const events: string[] = []

    loop.enqueueMacrotask(() => {
      events.push('macro')
      loop.enqueueNextTick(() => events.push('next-tick'))
      host.queuePromiseReaction(() => events.push('promise'))
      loop.shutdown()
    })

    expect(loop.runTurn()).toEqual({
      callbacksProcessed: 1,
      hasPendingWork: false,
      isAlive: false,
      nextWakeupAt: null,
      status: 'shutdown',
      taskKind: 'macrotask'
    })
    expect(events).toEqual(['macro'])
    expect(host.checkpointCount).toBe(0)
    expect(host.wakeups.at(-1)).toBe(null)
  })

  it('rejects a reentrant turn with a stable fatal error', () => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)
    const events: string[] = []

    loop.enqueueMacrotask(() => loop.runTurn())
    loop.enqueueMacrotask(() => events.push('second'))

    expect(() => loop.runTurn()).toThrowError(EventLoopReentrantTurnError)
    expect(host.terminations).toHaveLength(1)
    expect(host.terminations[0]).toMatchObject({
      code: 'ERR_HOLONOMY_TURN_REENTRANT',
      kind: 'error'
    })
    expect(loop.isDisposed).toBe(true)
    expect(events).toEqual([])
  })

  it('terminates with a stable error when nested tasks exhaust the turn budget', () => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host, { maxCallbacksPerTurn: 3 })
    const enqueueAgain = () => loop.enqueueNextTick(enqueueAgain)

    loop.enqueueMacrotask(() => loop.enqueueNextTick(enqueueAgain))

    expect(() => loop.runTurn()).toThrowError(EventLoopBudgetExceededError)
    expect(host.terminations).toHaveLength(1)
    expect(host.terminations[0]).toMatchObject({
      code: 'ERR_HOLONOMY_TASK_BUDGET_EXCEEDED',
      kind: 'error'
    })
    expect(loop.isDisposed).toBe(true)
  })

  it('fails deterministically when the host clock moves backwards', () => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)

    host.advanceTo(10)
    loop.setTimeout(() => {}, 1)
    host.advanceTo(9)

    expect(() => loop.runTurn()).toThrowError(EventLoopClockError)
    expect(host.terminations[0]).toMatchObject({
      code: 'ERR_HOLONOMY_CLOCK_NOT_MONOTONIC',
      kind: 'error'
    })
    expect(loop.isDisposed).toBe(true)
    expect(loop.getSnapshot().hasPendingWork).toBe(false)
  })

  it.each([
    {
      admit: (loop: RuntimeEventLoop) => loop.enqueueNextTick(() => {}),
      clock: Number.NaN,
      label: 'NaN before enqueueNextTick'
    },
    {
      admit: (loop: RuntimeEventLoop) => loop.registerNativeRequest('request'),
      clock: -1,
      label: 'negative before registerNativeRequest'
    }
  ])('fatally rejects an invalid host clock: $label', ({ admit, clock }) => {
    const host = new VirtualHostEventLoopPort()
    const loop = new RuntimeEventLoop(host)
    host.advanceTo(clock)

    expect(() => admit(loop)).toThrowError(EventLoopClockError)
    expect(host.terminations).toHaveLength(1)
    expect(host.terminations[0]).toMatchObject({
      code: 'ERR_HOLONOMY_CLOCK_NOT_MONOTONIC',
      kind: 'error'
    })
    expect(loop.isDisposed).toBe(true)
    expect(loop.getSnapshot()).toEqual({
      hasPendingWork: false,
      isAlive: false,
      nextWakeupAt: null
    })
    expect(host.wakeups.at(-1)).toBe(null)
  })
})
