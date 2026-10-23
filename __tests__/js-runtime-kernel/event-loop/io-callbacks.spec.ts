import { describe, expect, it } from 'vitest'

import { RuntimeEventLoop } from '../../../src/index.js'

const fixture = () => {
  let now = 0
  const events: string[] = []
  const loop = new RuntimeEventLoop({
    checkpointMicrotasks() {},
    now: () => now,
    requestWakeup() {},
    terminate() {}
  })
  return {
    loop,
    events,
    advance: (value: number) => {
      now = value
    }
  }
}

const drain = (loop: RuntimeEventLoop) => {
  for (let turns = 0; loop.getSnapshot().hasPendingWork; turns += 1) {
    expect(turns).toBeLessThan(32)
    loop.runTurn()
  }
}

describe('bounded local I/O callback phase', () => {
  it('drains already queued I/O, then check, then a due timer and later I/O', () => {
    const { loop, events, advance } = fixture()
    loop.enqueueIoCallback(() => {
      events.push('io-1')
      loop.setTimeout(() => {
        events.push('timer')
      }, 0)
      loop.enqueueImmediate(() => {
        events.push('immediate-1')
      })
      advance(10)
      loop.enqueueIoCallback(() => {
        events.push('io-later')
      })
    })
    loop.enqueueIoCallback(() => {
      events.push('io-2')
      loop.enqueueImmediate(() => {
        events.push('immediate-2')
      })
    })
    drain(loop)
    expect(events).toEqual(['io-1', 'io-2', 'immediate-1', 'immediate-2', 'timer', 'io-later'])
  })

  it('includes check callbacks enqueued by the engine checkpoint after an I/O turn', () => {
    const { loop, events, advance } = fixture()
    loop.enqueueIoCallback(() => {
      loop.setTimeout(() => {
        events.push('timer')
      }, 0)
      loop.enqueueImmediate(() => {
        events.push('immediate')
      })
      advance(10)
    })
    loop.runTurn()
    // Native/Node run the real engine checkpoint after returning from this turn.
    loop.enqueueImmediate(() => {
      events.push('promise-immediate')
    })
    drain(loop)
    expect(events).toEqual(['immediate', 'promise-immediate', 'timer'])
  })

  it('keeps a nested Immediate in the following bounded check batch', () => {
    const { loop, events, advance } = fixture()
    loop.enqueueIoCallback(() => {
      loop.setTimeout(() => {
        events.push('timer')
      }, 0)
      loop.enqueueImmediate(() => {
        events.push('immediate')
        loop.enqueueImmediate(() => {
          events.push('nested')
        })
      })
      advance(10)
    })
    drain(loop)
    expect(events).toEqual(['immediate', 'timer', 'nested'])
  })

  it('does not change ordinary macrotask ordering', () => {
    const { loop, events, advance } = fixture()
    loop.enqueueMacrotask(() => {
      loop.setTimeout(() => {
        events.push('timer')
      }, 0)
      loop.enqueueImmediate(() => {
        events.push('immediate')
      })
      advance(10)
    })
    drain(loop)
    expect(events).toEqual(['timer', 'immediate'])
  })

  it('retains cancellation, unreferenced liveness and disposal fencing', () => {
    const { loop, events } = fixture()
    loop.enqueueIoCallback(() => {
      events.push('io')
      loop.enqueueImmediate(() => {
        loop.dispose()
      })
    }, { ref: false })
    const cancelled = loop.enqueueIoCallback(() => {
      events.push('cancelled')
    }, { ref: false })
    expect(loop.cancelTask(cancelled)).toBe(true)
    expect(loop.getSnapshot().isAlive).toBe(false)
    loop.runTurn()
    loop.runTurn()
    expect(loop.isDisposed).toBe(true)
    expect(loop.getSnapshot().hasPendingWork).toBe(false)
    expect(events).toEqual(['io'])
  })
})
