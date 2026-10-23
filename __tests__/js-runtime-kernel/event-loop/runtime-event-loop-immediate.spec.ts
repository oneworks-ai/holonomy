import { describe, expect, it } from 'vitest'

import {
  EventLoopCallbackError,
  EventLoopWakeupError,
  RuntimeEventLoop,
  isHolonomyRuntimeError
} from '../../../src/index.js'

const makeHost = () => {
  const reactions: Array<() => void> = []
  const terminations: unknown[] = []
  let checkpoints = 0
  let now = 0
  return {
    checkpointMicrotasks() {
      checkpoints += 1
      while (reactions.length > 0) reactions.shift()!()
    },
    get checkpoints() {
      return checkpoints
    },
    now: () => now,
    queueReaction(callback: () => void) {
      reactions.push(callback)
    },
    requestWakeup(_deadline: number | null) {},
    setNow(value: number) {
      now = value
    },
    terminate(reason: unknown) {
      terminations.push(reason)
    },
    terminations
  }
}

describe('event loop Immediate check batches', () => {
  it('runs already-ready ordinary work, freezes the check batch, and defers nested Immediates', () => {
    const host = makeHost()
    const loop = new RuntimeEventLoop(host)
    const events: string[] = []
    loop.setTimeout(() => events.push('timer:before'), 0)
    loop.enqueueMacrotask(() => events.push('macro:before'))
    loop.enqueueImmediate(() => {
      events.push('immediate:first')
      loop.enqueueImmediate(() => events.push('immediate:nested'))
      loop.enqueueNextTick(() => events.push('tick'))
      host.queueReaction(() => events.push('promise'))
    })
    loop.enqueueImmediate(() => events.push('immediate:second'))
    loop.setTimeout(() => events.push('timer:after'), 0)
    loop.enqueueMacrotask(() => events.push('macro:after'))

    const kinds = Array.from({ length: 7 }, () => loop.runTurn().taskKind)
    expect(kinds).toEqual([
      'timer',
      'macrotask',
      'immediate',
      'immediate',
      'timer',
      'macrotask',
      'immediate'
    ])
    expect(events).toEqual([
      'timer:before',
      'macro:before',
      'immediate:first',
      'tick',
      'promise',
      'immediate:second',
      'timer:after',
      'macro:after',
      'immediate:nested'
    ])
    expect(host.checkpoints).toBe(7)
    expect(loop.runTurn().status).toBe('idle')
  })

  it('keeps next-tick-only checkpoints separate and applies reference state to liveness', () => {
    const host = makeHost()
    const loop = new RuntimeEventLoop(host)
    const events: string[] = []
    const id = loop.enqueueImmediate(() => events.push('immediate'))
    expect(loop.unrefImmediate(id)).toBe(true)
    expect(loop.hasRefImmediate(id)).toBe(false)
    expect(loop.getSnapshot()).toEqual({ hasPendingWork: true, isAlive: false, nextWakeupAt: null })
    expect(loop.runNextTickCheckpoint().status).toBe('idle')
    expect(host.checkpoints).toBe(0)
    expect(loop.refImmediate(id)).toBe(true)
    expect(loop.getSnapshot()).toMatchObject({ isAlive: true, nextWakeupAt: 0 })
    expect(loop.runTurn().taskKind).toBe('immediate')
    expect(events).toEqual(['immediate'])
    expect(loop.hasRefImmediate(id)).toBe(false)
    expect(loop.cancelTask(id)).toBe(false)
  })

  it('upgrades a same-deadline wakeup for next ticks and restores ordinary phase afterwards', () => {
    const wakeups: Array<[number | null, string | undefined]> = []
    const loop = new RuntimeEventLoop({
      checkpointMicrotasks() {},
      now: () => 0,
      requestWakeup(deadline, phase) {
        wakeups.push([deadline, phase])
      },
      terminate() {}
    })
    loop.enqueueImmediate(() => {})
    loop.enqueueNextTick(() => {})
    expect(wakeups).toEqual([[0, 'event-loop'], [0, 'next-tick']])
    expect(loop.runNextTickCheckpoint().taskKind).toBe('next-tick')
    expect(wakeups.at(-1)).toEqual([0, 'event-loop'])
  })

  it('cancels a queued Immediate and clears it on shutdown', () => {
    const host = makeHost()
    const loop = new RuntimeEventLoop(host)
    const events: string[] = []
    const canceled = loop.enqueueImmediate(() => events.push('canceled'))
    expect(loop.cancelTask(canceled)).toBe(true)
    loop.enqueueImmediate(() => events.push('shutdown'))
    loop.shutdown()
    expect(loop.getSnapshot().hasPendingWork).toBe(false)
    expect(loop.runTurn().status).toBe('shutdown')
    expect(events).toEqual([])
  })
})

describe('event loop thrown-value classification', () => {
  it('constructs branded errors without invoking poisoned prototype setters or mutable intrinsics', () => {
    const define = Object.defineProperty
    const targets: Array<[object, PropertyKey]> = [
      [Error.prototype, 'name'],
      [Object.prototype, 'code'],
      [Object.prototype, 'cause'],
      [WeakSet.prototype, 'add'],
      [WeakSet.prototype, 'has'],
      [Object, 'defineProperty']
    ]
    const originals = targets.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key))
    let traps = 0
    const trap = () => {
      traps += 1
      throw new Error('poisoned prototype')
    }
    let observed: { branded: boolean; cause: unknown; code: string; name: string } | undefined
    const cause = { identity: true }
    try {
      for (const [target, key] of targets) {
        define(target, key, { configurable: true, set: trap, get: trap })
      }
      const error = new EventLoopCallbackError(cause)
      observed = {
        branded: isHolonomyRuntimeError(error),
        cause: error.cause,
        code: error.code,
        name: error.name
      }
    } finally {
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        const [target, key] = targets[index]!
        const descriptor = originals[index]
        if (descriptor === undefined) Reflect.deleteProperty(target, key)
        else define(target, key, descriptor)
      }
    }
    expect(traps).toBe(0)
    expect(observed).toEqual({
      branded: true,
      cause,
      code: 'ERR_HOLONOMY_CALLBACK_FAILED',
      name: 'EventLoopCallbackError'
    })
  })

  it.each(['proxy', 'nested proxy', 'revoked proxy'])('does not inspect a thrown %s', kind => {
    let traps = 0
    const handler: ProxyHandler<object> = {
      getPrototypeOf() {
        traps += 1
        throw new Error('inspected prototype')
      },
      isExtensible() {
        traps += 1
        throw new Error('inspected extensibility')
      }
    }
    const inner = new Proxy({}, handler)
    const outer = new Proxy(inner, handler)
    const revoked = Proxy.revocable({}, handler).proxy
    const value = kind === 'proxy' ? inner : kind === 'nested proxy' ? outer : revoked
    if (kind === 'revoked proxy') {
      // Revoke this exact value without touching it afterwards.
      const pair = Proxy.revocable({}, handler)
      pair.revoke()
      const host = makeHost()
      const loop = new RuntimeEventLoop(host)
      loop.enqueueImmediate(() => {
        throw pair.proxy
      })
      let caught: unknown
      try {
        loop.runTurn()
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(EventLoopCallbackError)
      expect((caught as EventLoopCallbackError).cause).toBe(pair.proxy)
      expect(host.terminations[0]).toMatchObject({ code: 'ERR_HOLONOMY_CALLBACK_FAILED' })
    } else {
      const host = makeHost()
      const loop = new RuntimeEventLoop(host)
      loop.enqueueImmediate(() => {
        throw value
      })
      let caught: unknown
      try {
        loop.runTurn()
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(EventLoopCallbackError)
      expect((caught as EventLoopCallbackError).cause).toBe(value)
      expect(host.terminations[0]).toMatchObject({ code: 'ERR_HOLONOMY_CALLBACK_FAILED' })
    }
    expect(traps).toBe(0)
  })

  it('wraps an unsafe thrown value even when callback shutdown already disposed the loop', () => {
    let traps = 0
    const value = new Proxy({}, {
      getPrototypeOf() {
        traps += 1
        throw new Error('trap')
      }
    })
    const host = makeHost()
    const loop = new RuntimeEventLoop(host)
    loop.enqueueImmediate(() => {
      loop.shutdown()
      throw value
    })
    let caught: unknown
    try {
      loop.runTurn()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(EventLoopCallbackError)
    expect((caught as EventLoopCallbackError).cause).toBe(value)
    expect(traps).toBe(0)
  })

  it('normalizes an unsafe wakeup throw without inspecting it', () => {
    let traps = 0
    const value = new Proxy({}, {
      getPrototypeOf() {
        traps += 1
        throw new Error('trap')
      }
    })
    const host = makeHost()
    host.requestWakeup = () => {
      throw value
    }
    const loop = new RuntimeEventLoop(host)
    let caught: unknown
    try {
      loop.enqueueImmediate(() => {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(EventLoopWakeupError)
    expect((caught as EventLoopWakeupError).cause).toBe(value)
    expect(traps).toBe(0)
  })
})
