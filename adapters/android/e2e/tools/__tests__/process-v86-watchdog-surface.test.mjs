import { emit, eventTarget } from '@holonomyjs/capability-process/kernel/guest-child-process-events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { watchV86Child } from '../../../../../conformance/capabilities/process-v86-watchdog.mjs'

const budget = { cleanupGraceMs: 15, watchdogMs: 100 }
const actualFacade = ({ removalError, neverClose = false } = {}) => {
  const listeners = new Map()
  const child = eventTarget(listeners, Object.create(null))
  const data = vi.fn()
  const kill = vi.fn(() => {
    if (!neverClose) emit(listeners, 'close', null, 'SIGKILL')
    return true
  })
  child.kill = kill
  if (removalError) {
    child.removeListener = () => {
      throw removalError
    }
  }
  Object.freeze(child)
  let scope
  let terminal
  const promise = watchV86Child('minimal ChildProcess', value => {
    scope = value
    scope.on(child, 'data', data)
    child.once('close', () => scope.resolve('closed'))
    return child
  }, budget)
  promise.then(value => {
    terminal = { value }
  }, error => {
    terminal = { error }
  })
  return { child, data, kill, promise, scope, terminal: () => terminal, emit: (...args) => emit(listeners, ...args) }
}

describe('watchdog compatibility with the actual shared ChildProcess event target', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0)
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('settles normal close with only on/once and deactivates late callbacks', async () => {
    const h = actualFacade()
    expect(h.child.removeListener).toBeUndefined()
    expect(h.child.off).toBeUndefined()
    h.emit('close', 0, null) // actual emit swallows listener exceptions, as in the device facade
    await Promise.resolve()
    expect(h.terminal()).toEqual({ value: 'closed' })
    h.emit('data', 'late')
    expect(h.data).not.toHaveBeenCalled()
    expect(h.kill).not.toHaveBeenCalled()
  })

  it('keeps timeout failure when kill synchronously closes the minimal facade', async () => {
    const h = actualFacade()
    await vi.advanceTimersByTimeAsync(100)
    await expect(h.promise).rejects.toThrow('Timed out waiting for minimal ChildProcess')
    expect(h.kill).toHaveBeenCalledWith('SIGKILL')
    h.emit('data', 'late')
    expect(h.data).not.toHaveBeenCalled()
  })

  it('fails within cleanup grace when the minimal facade never closes', async () => {
    const h = actualFacade({ neverClose: true })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.terminal()).toBeUndefined()
    h.emit('data', 'after timeout')
    expect(h.data).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15)
    await expect(h.promise).rejects.toThrow('Timed out waiting for minimal ChildProcess')
  })

  it('rejects cleanup failure instead of leaving a successful close permanently pending', async () => {
    const removalError = new Error('removal failed')
    const h = actualFacade({ removalError })
    h.emit('close', 0, null)
    await Promise.resolve()
    expect(h.terminal()).toEqual({ error: removalError })
    h.emit('data', 'late')
    expect(h.data).not.toHaveBeenCalled()
  })

  for (const original of [undefined, new Error('primary failure')]) {
    it(`preserves ${original === undefined ? 'void' : 'original'} failure despite cleanup errors`, async () => {
      const h = actualFacade({ removalError: new Error('secondary failure') })
      expect(() => h.scope.reject(original)).not.toThrow()
      await expect(h.promise).rejects.toBe(original)
      h.emit('data', 'late')
      expect(h.data).not.toHaveBeenCalled()
    })
  }

  it('does not kill or arm new timers for an already-queued late watchdog callback', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const h = actualFacade()
    const callback = timer.mock.calls[0][0]
    h.emit('close', 0, null)
    await Promise.resolve()
    callback()
    expect(h.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  for (const original of ['successful close', undefined, new Error('primary error')]) {
    it(`always settles when timer cleanup throws (${String(original)})`, async () => {
      const h = actualFacade()
      const cleanupError = new Error('timer cleanup failed')
      vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => {
        throw cleanupError
      })
      if (original === 'successful close') h.emit('close', 0, null)
      else h.scope.reject(original)
      await Promise.resolve()
      expect(h.terminal()).toEqual({ error: original === 'successful close' ? cleanupError : original })
      h.emit('data', 'late')
      expect(h.data).not.toHaveBeenCalled()
      // A timer whose cancellation threw may remain queued, but it is inert.
      await vi.advanceTimersByTimeAsync(100)
      expect(h.kill).not.toHaveBeenCalled()
    })
  }
})
