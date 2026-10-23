import { describe, expect, it, vi } from 'vitest'

import { createWebAbortConstructors } from '../../../packages/capabilities/network/src/web/web-abort.js'
import { RuntimeEventLoop } from '../../../packages/runtime/src/event-loop/runtime-event-loop.js'
import { prepareNativeCallOptions } from '../../../packages/runtime/src/native-port/request-validation.js'

class ClockHost {
  time = 0
  checkpointMicrotasks() {}
  now() {
    return this.time
  }
  requestWakeup() {}
  terminate() {}
}

const setup = (maxTimerDelayMs?: number) => {
  const host = new ClockHost()
  const loop = new RuntimeEventLoop(host, maxTimerDelayMs == null ? {} : { maxTimerDelayMs })
  return { host, loop, abort: createWebAbortConstructors(loop) }
}

describe('runtime AbortSignal', () => {
  it('uses a genuine per-Runtime signal brand accepted by NativeBridge', () => {
    const { abort } = setup()
    const controller = new abort.AbortController()
    const signal = controller.signal
    expect(signal instanceof abort.AbortSignal).toBe(true)
    expect(Object.getOwnPropertyDescriptor(abort.AbortSignal.prototype, 'aborted')?.get).toBeTypeOf('function')
    expect(
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(abort.AbortSignal.prototype),
        'addEventListener'
      )?.value
    ).toBeTypeOf('function')

    const previous = Object.getOwnPropertyDescriptor(globalThis, 'AbortSignal')!
    try {
      Object.defineProperty(globalThis, 'AbortSignal', { configurable: true, value: abort.AbortSignal })
      const prepared = prepareNativeCallOptions({ signal: signal as unknown as AbortSignal })
      let cancelled = 0
      prepared.abortSignal!.add(() => {
        cancelled += 1
      })
      controller.abort('stop')
      expect(cancelled).toBe(1)
      expect(prepared.abortSignal!.readAborted()).toBe(true)
      expect(() => prepareNativeCallOptions({ signal: {} as AbortSignal })).toThrow()
      expect(() =>
        prepareNativeCallOptions({
          signal: new Proxy(signal, {}) as unknown as AbortSignal
        })
      ).toThrow()
    } finally {
      Object.defineProperty(globalThis, 'AbortSignal', previous)
      abort.dispose()
    }
  })

  it('validates Node delay range and delivers zero and long delays on unreferenced loop timers', () => {
    const { host, loop, abort } = setup(5)
    const Signal = abort.AbortSignal
    for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 4_294_967_296]) {
      expect(() => Signal.timeout(value)).toThrow(RangeError)
    }
    expect(() => Signal.timeout('1' as unknown as number)).toThrow(TypeError)
    expect(() => Signal.timeout(1n as unknown as number)).toThrow(TypeError)
    const zero = Signal.timeout(0)
    const long = Signal.timeout(12)
    Object.defineProperty(zero, 'dispatchAbort', {
      value: () => {
        throw new Error('shadowed abort')
      }
    })
    Object.defineProperty(zero, 'dispatchEvent', {
      value: () => {
        throw new Error('shadowed dispatch')
      }
    })
    expect(zero.aborted).toBe(false)
    expect(long.aborted).toBe(false)
    expect(loop.getSnapshot()).toMatchObject({ hasPendingWork: true, isAlive: false, nextWakeupAt: null })
    expect(loop.runTurn().taskKind).toBe('timer')
    expect(zero.reason).toMatchObject({ name: 'TimeoutError' })
    host.time = 5
    loop.runTurn()
    expect(long.aborted).toBe(false)
    host.time = 10
    loop.runTurn()
    expect(long.aborted).toBe(false)
    host.time = 12
    loop.runTurn()
    expect(long.reason).toMatchObject({ name: 'TimeoutError' })
    expect(loop.getSnapshot().hasPendingWork).toBe(false)
    abort.dispose()
  })

  it('composes the first reason and handles duplicate inputs', () => {
    const { abort } = setup()
    const first = new abort.AbortController()
    const second = new abort.AbortController()
    const combined = abort.AbortSignal.any([
      first.signal,
      first.signal,
      second.signal
    ] as unknown as AbortSignal[])
    first.abort(null)
    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBeNull()
    second.abort('late')
    expect(combined.reason).toBeNull()

    const already = abort.AbortSignal.abort('already')
    expect(abort.AbortSignal.any([already, second.signal] as unknown as AbortSignal[]).reason).toBe('already')
    expect(abort.AbortSignal.any([]).aborted).toBe(false)
    expect(() => abort.AbortSignal.any([{}] as AbortSignal[])).toThrow(TypeError)
    expect(() => abort.AbortSignal.any([new Proxy(first.signal, {})] as unknown as AbortSignal[])).toThrow(TypeError)
    abort.dispose()
  })

  it('ignores synthetic abort events and bypasses shadowed signal methods', () => {
    const { abort } = setup()
    const controller = new abort.AbortController()
    const source = controller.signal
    const addShadow = vi.fn(() => {
      throw new Error('shadowed add')
    })
    const removeShadow = vi.fn(() => {
      throw new Error('shadowed remove')
    })
    Object.defineProperty(source, 'addEventListener', { value: addShadow })
    Object.defineProperty(source, 'removeEventListener', { value: removeShadow })
    const combined = abort.AbortSignal.any([source] as unknown as AbortSignal[])
    source.dispatchEvent({ type: 'abort' })
    expect(combined.aborted).toBe(false)
    Object.defineProperty(source, 'dispatchEvent', {
      value: () => {
        throw new Error('shadowed dispatch')
      }
    })
    Object.defineProperty(combined, 'dispatchAbort', {
      value: () => {
        throw new Error('shadowed abort')
      }
    })
    Object.defineProperty(combined, 'dispatchEvent', {
      value: () => {
        throw new Error('shadowed dispatch')
      }
    })
    expect(Object.getOwnPropertyDescriptor(abort.AbortController.prototype, 'signal')?.get).toBeTypeOf('function')
    Object.defineProperty(controller, 'signal', { value: null })
    expect(() => controller.abort('real')).not.toThrow()
    expect(source.reason).toBe('real')
    expect(combined.reason).toBe('real')
    expect(addShadow).not.toHaveBeenCalled()
    expect(removeShadow).not.toHaveBeenCalled()
    Object.defineProperty(abort.AbortSignal.prototype, 'dispatchAbort', {
      value: () => {
        throw new Error('shadowed static abort')
      }
    })
    expect(abort.AbortSignal.abort('static').reason).toBe('static')
    abort.dispose()
  })

  it('continues cancellation after throwing user listeners', () => {
    const { abort } = setup()
    const scheduled: Array<() => void> = []
    const report = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => {
      scheduled.push(callback)
    })
    try {
      const source = new abort.AbortController()
      const combined = abort.AbortSignal.any([source.signal] as unknown as AbortSignal[])
      let cancelled = 0
      combined.onabort = () => {
        throw new Error('onabort failed')
      }
      combined.addEventListener('abort', () => {
        throw new Error('listener failed')
      })
      combined.addEventListener('abort', () => {
        cancelled += 1
      })
      expect(() => source.abort('stop')).not.toThrow()
      expect(cancelled).toBe(1)
      expect(combined.reason).toBe('stop')
      expect(scheduled).toHaveLength(2)
      combined.dispatchEvent({ type: 'abort' })
      expect(cancelled).toBe(1)
    } finally {
      report.mockRestore()
      abort.dispose()
    }
  })

  it('clears only its own timers on dispose and loop shutdown', () => {
    const host = new ClockHost()
    const loop = new RuntimeEventLoop(host)
    const first = createWebAbortConstructors(loop)
    const second = createWebAbortConstructors(loop)
    const firstSignal = first.AbortSignal.timeout(8)
    const secondSignal = second.AbortSignal.timeout(8)
    first.dispose()
    expect(loop.getSnapshot().hasPendingWork).toBe(true)
    host.time = 8
    loop.runTurn()
    expect(firstSignal.aborted).toBe(false)
    expect(secondSignal.reason).toMatchObject({ name: 'TimeoutError' })
    expect(loop.isDisposed).toBe(false)
    const pending = second.AbortSignal.timeout(100)
    loop.shutdown()
    expect(pending.aborted).toBe(false)
    expect(() => second.AbortSignal.timeout(0)).toThrow(TypeError)
  })
})
