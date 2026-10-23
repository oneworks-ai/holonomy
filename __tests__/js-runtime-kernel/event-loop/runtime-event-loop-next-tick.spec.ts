import { describe, expect, it } from 'vitest'

import { RuntimeEventLoop } from '../../../src/index.js'

describe('next-tick-only Event Loop checkpoint', () => {
  it('leaves ready macrotasks and timers for ordinary turns', () => {
    const events: string[] = []
    const reactions: Array<() => void> = []
    let checkpointCount = 0
    const loop = new RuntimeEventLoop({
      checkpointMicrotasks() {
        checkpointCount += 1
        while (reactions.length > 0) reactions.shift()!()
      },
      now: () => 0,
      requestWakeup() {},
      terminate() {}
    })
    loop.enqueueMacrotask(() => events.push('macro'))
    loop.setTimeout(() => events.push('timer'), 0)
    loop.enqueueNextTick(() => {
      events.push('tick:outer')
      loop.enqueueNextTick(() => events.push('tick:nested'))
    })
    reactions.push(() => events.push('promise'))

    expect(loop.runNextTickCheckpoint()).toMatchObject({
      callbacksProcessed: 2,
      status: 'ran',
      taskKind: 'next-tick'
    })
    expect(events).toEqual(['tick:outer', 'tick:nested', 'promise'])
    expect(checkpointCount).toBe(1)
    expect(loop.getSnapshot().hasPendingWork).toBe(true)
    expect(loop.runNextTickCheckpoint()).toMatchObject({
      callbacksProcessed: 0,
      status: 'idle',
      taskKind: null
    })
    expect(checkpointCount).toBe(1)
    loop.runTurn()
    loop.runTurn()
    expect(events).toEqual(['tick:outer', 'tick:nested', 'promise', 'macro', 'timer'])
  })
})
