import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

describe('Timers', () => {
  it('installs the public timer globals', () => {
    assert.equal(typeof setTimeout, 'function')
    assert.equal(typeof clearTimeout, 'function')
    assert.equal(typeof setInterval, 'function')
    assert.equal(typeof clearInterval, 'function')
  })

  it('runs microtasks before a due timeout', async () => {
    const order = ['sync']
    Promise.resolve().then(() => order.push('microtask'))
    await new Promise(resolve => {
      setTimeout(() => {
        order.push('timer')
        resolve()
      }, 20)
    })
    assert.deepEqual(order, ['sync', 'microtask', 'timer'])
  })

  it('cancels a timeout', async () => {
    let called = false
    const cancelled = setTimeout(() => {
      called = true
    }, 5)
    clearTimeout(cancelled)
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(called, false)
  })

  it('repeats and clears an interval', async () => {
    let count = 0
    await new Promise(resolve => {
      const interval = setInterval(() => {
        count += 1
        if (count === 3) {
          clearInterval(interval)
          resolve()
        }
      }, 5)
    })
    assert.equal(count, 3)
  })
})
