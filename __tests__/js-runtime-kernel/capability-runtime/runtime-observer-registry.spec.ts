import { describe, expect, it, vi } from 'vitest'

import { OBSERVER_EVENTS_V1, RuntimeObserverRegistryV1 } from '../../../packages/runtime/src/kernel/index.js'

const platform = {
  events: OBSERVER_EVENTS_V1.map(event => ({
    cost: event === 'gc.completed' ? 'high' as const : 'low' as const,
    event,
    optIn: event === 'gc.completed',
    supportLevel: event === 'memory.pressure' ? 'unsupported' as const : event === 'script.compiled'
      ? 'optional' as const
      : 'required' as const
  })),
  maxObserverCallbackMs: 100,
  maxQueuedEvents: 8,
  schemaVersion: 1 as const
}

const policy = {
  maxObserverCallbackMs: 20,
  maxQueuedEvents: 4,
  observerEvents: OBSERVER_EVENTS_V1.filter(event => event !== 'memory.pressure')
}

const options = (onDiagnostic?: (value: unknown) => void) => ({
  generation: 3,
  hostCaps: { maxObserverCallbackMs: 50, maxQueuedEvents: 2 },
  now: (() => {
    let now = 10
    return () => ++now
  })(),
  onDiagnostic,
  platform,
  policy
})

describe('runtime observer registry v1', () => {
  it('intersects registration with Policy, platform support, opt-in and Host caps', () => {
    const registry = new RuntimeObserverRegistryV1(options())
    expect(() => registry.subscribe({ events: ['memory.pressure'] }, () => undefined)).toThrow()
    expect(() => registry.subscribe({ events: ['gc.completed'] }, () => undefined)).toThrow()
    expect(() =>
      registry.subscribe({ acceptHighCost: true, events: ['gc.completed'], maxQueuedEvents: 3 }, () => undefined)
    ).not.toThrow()
    registry.close()
  })

  it('never backpressures the producer and isolates callback timeout and rejection', async () => {
    vi.useFakeTimers()
    try {
      const diagnostics: unknown[] = []
      const received: string[] = []
      const registry = new RuntimeObserverRegistryV1(options(value => diagnostics.push(value)))
      registry.subscribe(
        { callbackTimeoutMs: 5, events: ['runtime.exception'], maxQueuedEvents: 1 },
        () => new Promise(() => undefined)
      )
      registry.subscribe(
        { callbackTimeoutMs: 5, events: ['runtime.exception'], maxQueuedEvents: 1 },
        event => {
          received.push(event.event)
          throw new Error('observer failure')
        }
      )

      expect(registry.publish('runtime.exception', { code: 'fixture.failed' })?.sequence).toBe(1)
      expect(received).toEqual([])
      await vi.runAllTimersAsync()
      expect(received).toEqual(['runtime.exception'])
      expect(diagnostics).toEqual(expect.arrayContaining([
        { event: 'runtime.exception', kind: 'callback.failed' },
        { event: 'runtime.exception', kind: 'callback.timeout' }
      ]))
      registry.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses a reserved overflow record and preserves sequence order under queue pressure', async () => {
    const received: Array<{ event: string; payload: Record<string, unknown>; sequence: number }> = []
    const registry = new RuntimeObserverRegistryV1(options())
    registry.subscribe(
      { events: ['runtime.exception', 'runtime.terminated', 'script.compiled'], maxQueuedEvents: 1 },
      event => {
        received.push(event as never)
      }
    )

    registry.publish('runtime.exception', { code: 'first' })
    registry.publish('script.compiled', {
      scriptId: 'script-1',
      sourceBytes: 1,
      sourceSha256: 'a'.repeat(64)
    })
    registry.publish('runtime.terminated', { reason: 'completed' })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(received.map(event => event.event)).toEqual(['observer.overflow', 'runtime.terminated'])
    expect(received[0]?.payload).toEqual({
      dropped: 2,
      droppedByEvent: { 'runtime.exception': 1, 'script.compiled': 1 },
      firstDroppedSequence: 1,
      lastDroppedSequence: 2
    })
    expect(received[0]!.sequence).toBeLessThan(received[1]!.sequence)
    registry.close()
  })

  it('fences queued and late observer work after dispose and close', async () => {
    vi.useFakeTimers()
    try {
      const received: string[] = []
      const registry = new RuntimeObserverRegistryV1(options())
      const subscription = registry.subscribe(
        { callbackTimeoutMs: 5, events: ['runtime.exception'], maxQueuedEvents: 2 },
        async event => {
          received.push(event.payload.code as string)
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      )
      registry.publish('runtime.exception', { code: 'started' })
      await vi.advanceTimersByTimeAsync(0)
      registry.publish('runtime.exception', { code: 'queued' })
      subscription.dispose()
      registry.publish('runtime.exception', { code: 'after-dispose' })
      await vi.runAllTimersAsync()
      expect(received).toEqual(['started'])
      registry.close()
      expect(registry.publish('runtime.exception', { code: 'after-close' })).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses a timed-out callback diagnostic after generation close', async () => {
    vi.useFakeTimers()
    try {
      const diagnostics: unknown[] = []
      const registry = new RuntimeObserverRegistryV1(options(value => diagnostics.push(value)))
      registry.subscribe(
        { callbackTimeoutMs: 5, events: ['runtime.exception'] },
        () => new Promise(() => undefined)
      )
      registry.publish('runtime.exception', { code: 'fixture.failed' })
      await vi.advanceTimersByTimeAsync(0)
      registry.close()
      await vi.runAllTimersAsync()
      expect(diagnostics).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
