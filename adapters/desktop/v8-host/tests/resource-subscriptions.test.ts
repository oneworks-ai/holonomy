import { describe, expect, it } from 'vitest'

import { validateFiniteJsonSchemaV1 } from '../../../../packages/runtime/src/kernel/finite-schema-validator.js'
import { operationSchemaOwnerV1 } from '../../../../packages/runtime/src/kernel/registry-schema-ids.js'

import { createNativeResourceSubscriptions } from '../bootstrap/resource-subscriptions.mjs'

const setup = (schemaId: string, providerModule: string, maximum = 1) => {
  const listeners = new Map<string, (event: unknown) => void>()
  const released: string[] = []
  const kernel = {
    resourceEventDescriptor: () => ({ eventSchemaId: schemaId, providerModule, resourceType: 'test' }),
    releaseResource: (id: string) => released.push(id),
    subscribeResource(id: string, listener: (event: unknown) => void) {
      listeners.set(id, listener)
      return () => listeners.delete(id)
    }
  }
  const closed: string[] = []
  const providers = new Map([
    ['host.fs', { poll: () => [] as string[] }],
    ['host.process', { poll: () => closed.splice(0) }]
  ])
  const subscriptions = createNativeResourceSubscriptions(kernel, providers, maximum)
  return {
    closed,
    emit: (event: unknown) => listeners.get('owned')?.(event),
    released,
    subscriptions
  }
}

const events = (batch: string) =>
  JSON.parse(batch).events.map(
    (record: { event: string }) => JSON.parse(record.event)
  )
const expectValidEvents = (schemaId: string, terminal: unknown[]) => {
  const schema = operationSchemaOwnerV1(schemaId)?.schema
  expect(schema).toBeDefined()
  for (const event of terminal) expect(validateFiniteJsonSchemaV1(schema!, event)).toBe(true)
}

describe('native resource subscriptions', () => {
  it('keeps filesystem overflow error and close delivery', () => {
    const fixture = setup('VirtualFsWatcherDeliveryV1', 'host.fs')
    fixture.subscriptions.subscribe('owned')
    fixture.emit({ event: 'change', tuple: ['change', 'file'] })
    fixture.emit({ event: 'change', tuple: ['change', 'other'] })
    const terminal = events(fixture.subscriptions.drain())
    expect(terminal.map((event: { event: string }) => event.event)).toEqual(['error', 'close'])
    expect(terminal[0].tuple[0].code).toBe('ENOSPC')
    expectValidEvents('VirtualFsWatcherDeliveryV1', terminal)
    expect(fixture.released).toEqual(['owned'])
  })

  it('delivers Process readable overflow through the same queue and polls its provider', () => {
    const fixture = setup('ChildProcessReadableEventV1', 'host.process')
    fixture.subscriptions.subscribe('owned')
    for (let index = 0; index <= 256; index++) fixture.emit({ event: 'data', tuple: [index] })
    const terminal = events(fixture.subscriptions.drain())
    expect(terminal.map((event: { event: string }) => event.event)).toEqual(['error', 'close'])
    expect(terminal[0].tuple[0].code).toBe('EMFILE')
    expectValidEvents('ChildProcessReadableEventV1', terminal)
    expect(fixture.released).toEqual(['owned'])

    const second = setup('ChildProcessEventV1', 'host.process')
    second.subscriptions.subscribe('owned')
    second.closed.push('owned')
    expect(events(second.subscriptions.drain())).toEqual([])
    expect(second.released).toEqual(['owned'])
  })

  it('closes Process stdin on overflow so pending callbacks settle in the Guest', () => {
    const fixture = setup('ChildProcessStdinEventV1', 'host.process')
    fixture.subscriptions.subscribe('owned')
    for (let index = 0; index <= 256; index++) fixture.emit({ callbackId: index + 1, error: null, event: 'callback' })
    const terminal = events(fixture.subscriptions.drain())
    expect(terminal).toEqual([{ event: 'close' }])
    expectValidEvents('ChildProcessStdinEventV1', terminal)
    expect(fixture.released).toEqual(['owned'])
  })

  it('sends Process child error and a valid close tuple before releasing the owned child', () => {
    const fixture = setup('ChildProcessEventV1', 'host.process')
    fixture.subscriptions.subscribe('owned')
    for (let index = 0; index <= 256; index++) fixture.emit({ event: 'spawn', tuple: [] })
    const terminal = events(fixture.subscriptions.drain())
    expect(terminal.map((event: { event: string }) => event.event)).toEqual(['error', 'close'])
    expect(terminal[1].tuple).toEqual([null, 'SIGKILL'])
    expectValidEvents('ChildProcessEventV1', terminal)
    expect(fixture.released).toEqual(['owned'])
  })

  it('bounds encoded Process output before count capacity is exhausted', () => {
    const fixture = setup('ChildProcessReadableEventV1', 'host.process')
    fixture.subscriptions.subscribe('owned')
    const chunk = 'x'.repeat(512 * 1024)
    for (let index = 0; index < 65; index++) fixture.emit({ event: 'data', tuple: [chunk] })
    const terminal = events(fixture.subscriptions.drain())
    expect(terminal.map((event: { event: string }) => event.event)).toEqual(['error', 'close'])
    expect(fixture.released).toEqual(['owned'])
  })

  it('accounts for the outer event envelope escaping', () => {
    const fixture = setup('ChildProcessReadableEventV1', 'host.process')
    fixture.subscriptions.subscribe('owned')
    const chunk = '\\'.repeat(256 * 1024)
    for (let index = 0; index < 40; index++) fixture.emit({ event: 'data', tuple: [chunk] })
    const terminal = events(fixture.subscriptions.drain())
    expect(terminal.map((event: { event: string }) => event.event)).toEqual(['error', 'close'])
    expect(fixture.released).toEqual(['owned'])
  })

  it('rejects schema/provider mismatch before subscribing', () => {
    const fixture = setup('ChildProcessEventV1', 'host.fs')
    expect(() => fixture.subscriptions.subscribe('owned')).toThrow('Unsupported native resource event schema')
  })

  it('releases terminal subscriptions across more Process children than the 256-slot limit', () => {
    const listeners = new Map<string, (event: unknown) => void>()
    const kernel = {
      resourceEventDescriptor: () => ({
        eventSchemaId: 'ChildProcessEventV1',
        providerModule: 'host.process',
        resourceType: 'process.child'
      }),
      releaseResource() {},
      subscribeResource(id: string, listener: (event: unknown) => void) {
        listeners.set(id, listener)
        return () => listeners.delete(id)
      }
    }
    const subscriptions = createNativeResourceSubscriptions(kernel, new Map(), 1)
    for (let index = 0; index < 300; index++) {
      const bindingId = `child-${index}`
      subscriptions.subscribe(bindingId)
      listeners.get(bindingId)!({ event: 'close', tuple: [0, null] })
      expect(events(subscriptions.drain())).toEqual([{ event: 'close', tuple: [0, null] }])
      expect(listeners.size).toBe(0)
    }
  })
})
