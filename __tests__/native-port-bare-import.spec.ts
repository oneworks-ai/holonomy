import { describe, expect, it, vi } from 'vitest'

describe('holonomy runtime bare V8-compatible import', () => {
  it('does not read AbortSignal or EventTarget while evaluating the root module', async () => {
    const abortSignal = Object.getOwnPropertyDescriptor(globalThis, 'AbortSignal')
    const eventTarget = Object.getOwnPropertyDescriptor(globalThis, 'EventTarget')
    expect(abortSignal?.configurable).toBe(true)
    expect(eventTarget?.configurable).toBe(true)

    try {
      expect(Reflect.deleteProperty(globalThis, 'AbortSignal')).toBe(true)
      expect(Reflect.deleteProperty(globalThis, 'EventTarget')).toBe(true)
      vi.resetModules()
      await expect(import('../src/index.js')).resolves.toMatchObject({
        createNativeBridge: expect.any(Function),
        RuntimeEventLoop: expect.any(Function)
      })
    } finally {
      if (abortSignal) Object.defineProperty(globalThis, 'AbortSignal', abortSignal)
      if (eventTarget) Object.defineProperty(globalThis, 'EventTarget', eventTarget)
    }
  })
})
