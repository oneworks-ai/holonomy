import { describe, expect, it } from 'vitest'

import { createRuntimeTimers } from '../../../src/timers/index.js'

describe('runtime timers', () => {
  it('keeps timer scheduling native and callback ownership in JavaScript', () => {
    const scheduled: Array<{ delay: number; id: number; interval?: number }> = []
    const cancelled: number[] = []
    let nextId = 0
    const timers = createRuntimeTimers({
      cancel(id) {
        cancelled.push(id)
        return true
      },
      schedule(delay, interval) {
        const id = ++nextId
        scheduled.push({ delay, id, ...(interval == null ? {} : { interval }) })
        return id
      }
    })
    const calls: string[] = []
    const timeout = timers.globals.setTimeout(value => calls.push(String(value)), 10, 'timeout')
    const interval = timers.globals.setInterval(() => calls.push('interval'), 5)
    expect(scheduled).toEqual([
      { delay: 10, id: timeout },
      { delay: 5, id: interval, interval: 5 }
    ])
    expect(timers.fire(timeout)).toBe(true)
    expect(timers.fire(timeout)).toBe(false)
    expect(timers.fire(interval)).toBe(true)
    timers.globals.clearInterval(interval)
    expect(calls).toEqual(['timeout', 'interval'])
    expect(cancelled).toEqual([interval])
  })
})
