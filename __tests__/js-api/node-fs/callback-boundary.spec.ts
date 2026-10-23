import { describe, expect, it } from 'vitest'

import { CapabilityFsFacadeCallsV1 } from '@holonomyjs/capability-fs/kernel/guest-fs-calls'
import { createCapabilityCallbackDispatcherV1 } from '@holonomyjs/runtime/kernel/guest-facade-support'
import { RuntimeEventLoop } from '../../../packages/runtime/src/event-loop/index.js'

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const fixture = (result: string | Error) => {
  const events: string[] = []
  let termination: unknown
  const loop = new RuntimeEventLoop({
    checkpointMicrotasks: () => {
      events.push('checkpoint')
    },
    now: () => 0,
    requestWakeup() {},
    terminate: reason => {
      termination = reason
    }
  })
  const calls = new CapabilityFsFacadeCallsV1({
    enqueueCallback: createCapabilityCallbackDispatcherV1(loop),
    invoke: async () => {
      if (result instanceof Error) throw result
      return result
    },
    invokeSync: () => ''
  })
  return {
    calls,
    events,
    loop,
    get termination() {
      return termination
    }
  }
}

describe('capability filesystem callback boundary', () => {
  it('keeps accepted callback work referenced and drains ticks before the engine checkpoint', async () => {
    const { calls, events, loop } = fixture(JSON.stringify({ ok: true, value: 42 }))
    calls.callback('node:fs', 'readFile', {}, {}, (...args: unknown[]) => {
      expect(args).toEqual([null, 42])
      events.push('callback')
      loop.enqueueNextTick(() => {
        events.push('tick')
      })
    }, true)
    await flush()
    expect(events).toEqual([])
    expect(loop.getSnapshot().isAlive).toBe(true)
    loop.runTurn()
    expect(events).toEqual(['callback', 'tick', 'checkpoint'])
    expect(loop.getSnapshot().isAlive).toBe(false)
  })

  it.each([
    JSON.stringify({ ok: false, error: { code: 'ENOENT', message: 'missing', name: 'Error', retryable: false } }),
    new Error('transport failed')
  ])('queues terminal and transport failure with one callback argument', async result => {
    const { calls, events, loop } = fixture(result)
    calls.callback('node:fs', 'readFile', {}, {}, (...args: unknown[]) => {
      expect(args).toHaveLength(1)
      expect(args[0]).toBeInstanceOf(Error)
      events.push('error')
    }, true)
    await flush()
    expect(events).toEqual([])
    loop.runTurn()
    expect(events).toEqual(['error', 'checkpoint'])
  })

  it('preserves void callback arity and treats callback throw as a loop failure', async () => {
    const state = fixture(JSON.stringify({ ok: true, value: {} }))
    state.calls.callback('node:fs', 'unlink', {}, {}, (...args: unknown[]) => {
      expect(args).toEqual([null])
      throw new Error('callback original')
    }, false)
    await flush()
    expect(() => state.loop.runTurn()).toThrow('event-loop callback failed')
    expect(state.loop.isDisposed).toBe(true)
    expect(state.termination).toMatchObject({ kind: 'error' })
  })

  it('discards late terminals and already queued callbacks at disposal', async () => {
    for (const beforeResolution of [true, false]) {
      const { calls, events, loop } = fixture(JSON.stringify({ ok: true, value: 42 }))
      calls.callback('node:fs', 'readFile', {}, {}, () => {
        events.push('late')
      }, true)
      if (!beforeResolution) await flush()
      loop.dispose()
      await flush()
      loop.runTurn()
      expect(events).toEqual([])
    }
  })
})
