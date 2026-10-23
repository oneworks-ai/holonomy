import { describe, expect, it, vi } from 'vitest'

import { WebAbortController, WebAbortSignal } from '../../../packages/capabilities/network/src/web/web-abort.js'
import { prepareNativeCallOptions } from '../../../packages/runtime/src/native-port/request-validation.js'

describe('injected AbortSignal admission', () => {
  it.each([true, false])('uses its own branded listener prototype, global EventTarget present=%s', present => {
    const signalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AbortSignal')!
    const targetDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'EventTarget')!
    try {
      Object.defineProperty(globalThis, 'AbortSignal', { configurable: true, value: WebAbortSignal })
      if (!present) Reflect.deleteProperty(globalThis, 'EventTarget')
      const controller = new WebAbortController()
      const options = prepareNativeCallOptions({ signal: controller.signal as unknown as AbortSignal })
      let called = 0
      const listener = () => {
        called += 1
      }
      options.abortSignal!.add(listener)
      expect(options.abortSignal!.readAborted()).toBe(false)
      controller.abort()
      expect(called).toBe(1)
      expect(options.abortSignal!.readAborted()).toBe(true)
      options.abortSignal!.remove(listener)
      expect(() => prepareNativeCallOptions({ signal: { aborted: false } as AbortSignal })).toThrow()
    } finally {
      Object.defineProperty(globalThis, 'AbortSignal', signalDescriptor)
      Object.defineProperty(globalThis, 'EventTarget', targetDescriptor)
    }
  })

  it('reports throwing user callbacks after every native cancellation listener runs', () => {
    const signalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AbortSignal')!
    const errors: Array<() => void> = []
    const schedule = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => {
      errors.push(callback)
    })
    try {
      Object.defineProperty(globalThis, 'AbortSignal', { configurable: true, value: WebAbortSignal })
      const controller = new WebAbortController()
      const first = new Error('onabort failed')
      const second = new Error('listener failed')
      controller.signal.onabort = () => {
        throw first
      }
      controller.signal.addEventListener('abort', () => {
        throw second
      })
      const prepared = prepareNativeCallOptions({ signal: controller.signal as unknown as AbortSignal })
      let cancelled = 0
      prepared.abortSignal!.add(() => {
        cancelled += 1
      })
      expect(() => controller.abort()).not.toThrow()
      expect(cancelled).toBe(1)
      expect(prepared.abortSignal!.readAborted()).toBe(true)
      expect(errors).toHaveLength(2)
      expect(errors[0]).toThrow(first)
      expect(errors[1]).toThrow(second)
    } finally {
      schedule.mockRestore()
      Object.defineProperty(globalThis, 'AbortSignal', signalDescriptor)
    }
  })

  it('does not let a failing error reporter stop later cancellation listeners', () => {
    const schedule = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(() => {
      throw new Error('reporter failed')
    })
    try {
      const controller = new WebAbortController()
      let called = 0
      controller.signal.onabort = () => {
        throw new Error('user callback failed')
      }
      controller.signal.addEventListener('abort', () => {
        called += 1
      })
      expect(() => controller.abort()).not.toThrow()
      expect(called).toBe(1)
      expect(controller.signal.aborted).toBe(true)
    } finally {
      schedule.mockRestore()
    }
  })
})
