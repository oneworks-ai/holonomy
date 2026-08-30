import { describe, expect, it } from 'vitest'

import { CapabilityInvocationBrokerV1 } from '../../../src/capability-runtime/index.js'
import type { CapabilityBrokerProviderV1 } from '../../../src/capability-runtime/index.js'
import { creation, fsResource, snapshot } from './broker-fixtures.js'

const invocation = (requestId: string) => ({
  arguments: snapshot({ options: { encoding: 'utf8' }, path: 'holo-fs://workspace/demo.txt' }, 'argument'),
  invocationMode: 'promise' as const,
  member: 'readFile',
  module: 'node:fs/promises',
  requestId,
  resource: fsResource()
})

describe('capability plugin graph', () => {
  it('publishes ordered middleware snapshots and drains retired revisions', async () => {
    const events: string[] = []
    let completeFirst: (() => void) | undefined
    let providerCalls = 0
    const fs: CapabilityBrokerProviderV1 = {
      execution: 'async',
      module: 'host.fs',
      invoke: (_context, authority) => {
        providerCalls += 1
        const terminal = () => authority.complete(snapshot('value', 'result'))
        if (providerCalls === 1) {
          return new Promise(resolve => {
            completeFirst = () => resolve(terminal())
          })
        }
        return Promise.resolve(terminal())
      }
    }
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }),
      engine: 'node-vm',
      target: 'node'
    })
    const oldScope = broker.createPluginInterceptorScope('old')
    oldScope.use({}, async (_context, next) => {
      events.push('old:before')
      const result = await next()
      events.push('old:after')
      return result
    })
    broker.publishPluginGraph(1, [oldScope])
    const first = broker.invoke(invocation('old-graph'))
    await Promise.resolve()

    const newScope = broker.createPluginInterceptorScope('new')
    newScope.use({}, async (_context, next) => {
      events.push('new:before')
      const result = await next()
      events.push('new:after')
      return result
    })
    broker.publishPluginGraph(2, [newScope])
    let drained = false
    const drain = broker.drainPluginGraph(1).then(() => drained = true)
    await broker.invoke(invocation('new-graph'))
    expect(drained).toBe(false)
    completeFirst?.()
    await first
    await drain
    expect(events).toEqual(['old:before', 'new:before', 'new:after', 'old:after'])
    expect(drained).toBe(true)
  })
})
