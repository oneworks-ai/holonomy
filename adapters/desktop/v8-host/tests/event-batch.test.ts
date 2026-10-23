import { describe, expect, it } from 'vitest'
import { MAX_CONTROL_EVENT_BATCH_BYTES, drainNativeEventBatch } from '../bootstrap/event-batch.mjs'

describe('native encoded event transfer', () => {
  it('splits valid 1 MiB binary chunks by encoded bytes without losing or reordering them', () => {
    const base64 = 'A'.repeat(Math.ceil(1024 * 1024 / 3) * 4)
    const queue = Array.from({ length: 64 }, (_, id) => ({ id, binary: [{ handle: `body-${id}`, base64 }] }))
    const first = drainNativeEventBatch(queue)
    expect(new TextEncoder().encode(first).byteLength).toBeLessThanOrEqual(MAX_CONTROL_EVENT_BATCH_BYTES)
    const decoded = JSON.parse(first)
    expect(decoded.events.length).toBeGreaterThan(0)
    expect(decoded.events.length).toBeLessThan(64)
    expect(decoded.remaining).toBe(queue.length)
    const second = JSON.parse(drainNativeEventBatch(queue))
    expect([...decoded.events, ...second.events].map(event => event.id)).toEqual(
      Array.from({ length: 64 }, (_, id) => id)
    )
    expect(queue).toEqual([])
  })

  it('counts UTF-8 and JSON escapes and preserves the queue when one event cannot fit', () => {
    const queue = Array.from({ length: 5 }, (_, id) => ({ id, text: '\u0000中'.repeat(8) }))
    const result = drainNativeEventBatch(queue, 256)
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(256)
    expect(JSON.parse(result).remaining).toBe(queue.length)
    expect(queue.length).toBeGreaterThan(0)
    const previous = [...queue]
    expect(() => drainNativeEventBatch(queue, 80)).toThrow('Native event exceeds transport limit')
    expect(queue).toEqual(previous)
  })
})
