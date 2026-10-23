import { describe, expect, it } from 'vitest'

import {
  invokeCapabilityProviderAsyncV1,
  invokeCapabilityProviderSyncV1
} from '../../../packages/runtime/src/kernel/broker-provider-invocation.js'

const fixture = ({ count = 2, failAt = 1 } = {}) => {
  const events: string[] = []
  const context = { operation: 'fs.readFile', resource: { requested: { semanticResourceDigest: 'a'.repeat(64) } } }
  const plan = {
    dispose: () => events.push('plan.dispose'),
    execute: () => {
      throw new Error('must not execute')
    },
    requests: Array.from({ length: count }, (_, id) => ({
      id,
      verify: () => ({})
    }))
  }
  const admit = (request: { id: number }) => {
    events.push(`admit:${request.id}`)
    if (request.id === failAt) throw new Error('admission denied')
    return {
      authority: {},
      consume() {},
      context,
      dispose: () => events.push(`dispose:${request.id}`),
      token: {}
    }
  }
  const input = {
    authority: {},
    context,
    provider: { preflight: () => plan },
    resolution: { admit: async (request: { id: number }) => admit(request), admitSync: admit }
  } as unknown as Parameters<typeof invokeCapabilityProviderAsyncV1>[0]
  return { events, input }
}

describe('provider resolution preparation cleanup', () => {
  it('disposes an async plan when request validation rejects before admission', async () => {
    const { events, input } = fixture({ count: 0 })
    await expect(invokeCapabilityProviderAsyncV1(input)).rejects.toMatchObject({ code: 'provider.protocol_error' })
    expect(events).toEqual(['plan.dispose'])
  })

  it('disposes an async plan after the first admission rejects', async () => {
    const { events, input } = fixture({ failAt: 0 })
    await expect(invokeCapabilityProviderAsyncV1(input)).rejects.toThrow('admission denied')
    expect(events).toEqual(['admit:0', 'plan.dispose'])
  })

  it('disposes already admitted evidence and the async plan on a later denial', async () => {
    const { events, input } = fixture()
    await expect(invokeCapabilityProviderAsyncV1(input)).rejects.toThrow('admission denied')
    expect(events).toEqual(['admit:0', 'admit:1', 'dispose:0', 'plan.dispose'])
  })

  it('applies the same cleanup to synchronous validation and partial admission', () => {
    const invalid = fixture({ count: 0 })
    expect(() => invokeCapabilityProviderSyncV1(invalid.input)).toThrow()
    expect(invalid.events).toEqual(['plan.dispose'])
    const partial = fixture()
    expect(() => invokeCapabilityProviderSyncV1(partial.input)).toThrow('admission denied')
    expect(partial.events).toEqual(['admit:0', 'admit:1', 'dispose:0', 'plan.dispose'])
  })
})
