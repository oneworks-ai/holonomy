import { EventEmitter as NodeEventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { UnhandledErrorEventError } from '../../../src/node-compat/errors.js'
import { EventEmitter } from '../../../src/node-compat/events.js'

const runTrace = (Emitter: typeof EventEmitter | typeof NodeEventEmitter) => {
  const emitter = new Emitter()
  const trace: string[] = []
  const persistent = (value: unknown) => trace.push(`on:${String(value)}`)
  const single = (value: unknown) => trace.push(`once:${String(value)}`)
  emitter.on('value', persistent)
  emitter.once('value', single)
  const listenersBefore = emitter.listeners('value')
  const first = emitter.emit('value', 1)
  const second = emitter.emit('value', 2)
  emitter.off('value', persistent)
  return {
    first,
    listenersBefore: listenersBefore.map(listener => listener === persistent ? 'on' : 'once'),
    remaining: emitter.listenerCount('value'),
    second,
    trace
  }
}

describe('node:events compatibility', () => {
  it('matches Node ordering, once visibility and removal for the promised subset', () => {
    expect(runTrace(EventEmitter)).toEqual(runTrace(NodeEventEmitter))
  })

  it('removes once listeners before recursive emission', () => {
    const emitter = new EventEmitter()
    const trace: string[] = []
    emitter.once('tick', () => {
      trace.push('outer')
      emitter.emit('tick')
    })
    expect(emitter.emit('tick')).toBe(true)
    expect(trace).toEqual(['outer'])
    expect(emitter.listenerCount('tick')).toBe(0)
  })

  it('implements aliases, listener counts and max-listener state', () => {
    const emitter = new EventEmitter()
    const listener = () => undefined
    expect(emitter.addListener('event', listener)).toBe(emitter)
    emitter.addListener('event', listener)
    expect(emitter.listenerCount('event', listener)).toBe(2)
    expect(emitter.setMaxListeners(0).getMaxListeners()).toBe(0)
    expect(emitter.setMaxListeners(1.5).getMaxListeners()).toBe(1.5)
    expect(emitter.setMaxListeners(Number.POSITIVE_INFINITY).getMaxListeners()).toBe(
      Number.POSITIVE_INFINITY
    )
    expect(emitter.removeListener('event', listener)).toBe(emitter)
    expect(emitter.listenerCount('event')).toBe(1)
    expect(emitter.removeAllListeners('event').listeners('event')).toEqual([])
  })

  it('uses the basic Node error-event behavior', () => {
    const emitter = new EventEmitter()
    const failure = new Error('boom')
    expect(() => emitter.emit('error', failure)).toThrow(failure)
    expect(() => emitter.emit('error', 'context')).toThrow(UnhandledErrorEventError)
    emitter.on('error', () => undefined)
    expect(emitter.emit('error', failure)).toBe(true)
  })
})
