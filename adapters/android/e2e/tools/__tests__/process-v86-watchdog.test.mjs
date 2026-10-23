import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { v86TestBudget, watchV86Child } from '../../../../../conformance/capabilities/process-v86-watchdog.mjs'

const budget = { cleanupGraceMs: 15, watchdogMs: 100 }
const controlled = (kill = vi.fn(), selectedBudget = budget) => {
  const child = new EventEmitter()
  child.kill = kill
  let scope
  let terminal
  const promise = watchV86Child('controlled child', value => {
    scope = value
    scope.on(child, 'data', () => {})
    return child
  }, selectedBudget)
  promise.then(value => {
    terminal = { value }
  }, error => {
    terminal = { error }
  })
  return { child, kill, promise, scope, terminal: () => terminal }
}

describe('shared v86 conformance watchdog', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  for (const value of [undefined, { arity: 3, stderr: '', stdout: 'ok' }]) {
    it(`preserves normal ${value === undefined ? 'void' : 'tuple'} success and clears timers/listeners`, async () => {
      const h = controlled()
      h.scope.resolve(value)
      await expect(h.promise).resolves.toBe(value)
      expect(h.child.eventNames()).toEqual([])
      expect(h.kill).not.toHaveBeenCalled()
    })
  }

  it('preserves normal error identity and clears timers/listeners', async () => {
    const h = controlled()
    const error = new Error('original')
    h.scope.reject(error)
    await expect(h.promise).rejects.toBe(error)
    expect(h.child.eventNames()).toEqual([])
  })

  it('preserves a void rejection and synchronous void success', async () => {
    const h = controlled()
    h.scope.reject(undefined)
    await expect(h.promise).rejects.toBeUndefined()
    await expect(watchV86Child('sync', ({ resolve }) => {
      resolve()
    }, budget)).resolves.toBeUndefined()
    expect(h.child.eventNames()).toEqual([])
  })

  it('kills first, waits for close, and ignores late success/error after selecting timeout', async () => {
    const h = controlled()
    await vi.advanceTimersByTimeAsync(100)
    expect(h.kill).toHaveBeenCalledTimes(1)
    expect(h.kill).toHaveBeenCalledWith('SIGKILL')
    expect(h.terminal()).toBeUndefined()
    h.scope.resolve({ stdout: 'late success' })
    h.scope.reject(new Error('late error'))
    await Promise.resolve()
    expect(h.terminal()).toBeUndefined()
    h.child.emit('close', 0, null)
    await expect(h.promise).rejects.toThrow('Timed out waiting for controlled child')
    expect(h.child.eventNames()).toEqual([])
    const error = h.terminal().error
    h.scope.resolve('later')
    await Promise.resolve()
    expect(h.terminal().error).toBe(error)
  })

  for (const throws of [false, true]) {
    it(`fails within grace when ${throws ? 'kill throws' : 'child never closes'}`, async () => {
      const h = controlled(vi.fn(() => {
        if (throws) throw new Error('kill failed')
      }))
      await vi.advanceTimersByTimeAsync(100)
      expect(h.terminal()).toBeUndefined()
      await vi.advanceTimersByTimeAsync(14)
      expect(h.terminal()).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      await expect(h.promise).rejects.toThrow('Timed out waiting for controlled child')
      expect(h.child.eventNames()).toEqual([])
    })
  }

  it('keeps slow startup pending beyond the old outer deadlines', async () => {
    const h = controlled(vi.fn(), v86TestBudget)
    await vi.advanceTimersByTimeAsync(136_000)
    expect(h.kill).not.toHaveBeenCalled()
    expect(h.terminal()).toBeUndefined()
    h.scope.resolve({ stdout: 'ready then completed' })
    await expect(h.promise).resolves.toEqual({ stdout: 'ready then completed' })
  })

  it('handles synchronous close from kill and keeps the selected timeout', async () => {
    const h = controlled(vi.fn(() => {
      h.scope.resolve('late')
      h.child.emit('close', null, 'SIGKILL')
    }))
    await vi.advanceTimersByTimeAsync(100)
    await expect(h.promise).rejects.toThrow('Timed out waiting for controlled child')
  })

  it('cleans scoped auxiliary timers and a synchronous start failure', async () => {
    const h = controlled()
    const callback = vi.fn()
    h.scope.setTimeout(callback, 225)
    h.scope.resolve('done')
    await expect(h.promise).resolves.toBe('done')
    expect(callback).not.toHaveBeenCalled()
    const error = new Error('start failed')
    await expect(watchV86Child('start', () => {
      throw error
    }, budget)).rejects.toBe(error)
  })

  it('derives finite suite/runner bounds and matches the production startup default', () => {
    const b = v86TestBudget
    expect(Object.isFrozen(b)).toBe(true)
    expect(b.watchdogMs).toBe(425_000)
    expect(b.suiteWaitMs).toBe(12 * (b.watchdogMs + b.cleanupGraceMs) + b.setupTeardownMarginMs)
    expect(b.instrumentationTimeoutMs).toBe(2 * (b.startWaitMs + b.suiteWaitMs) + b.setupTeardownMarginMs)
    const factory = readFileSync(
      new URL(
        '../../../process-backend-v86/src/main/kotlin/ai/oneworks/holonomy/v86/AndroidV86RuntimeServicesFactory.kt',
        import.meta.url
      ),
      'utf8'
    )
    const constant = factory.match(/const val DEFAULT_STARTUP_TIMEOUT_MS = ([\d_]+)L/u)
    expect(Number(constant[1].replaceAll('_', ''))).toBe(b.startupTimeoutMs)
    expect(factory).toContain('backendStartupTimeoutMs: Long = DEFAULT_STARTUP_TIMEOUT_MS')
  })
})
