import { describe, expect, it } from 'vitest'

import { NetworkMockRuleStore, RuntimeControlChannel, createNetworkRuleControlHandler } from '../../../src/index.js'

describe('runtime control channel', () => {
  it('serializes generation-bound updates and replays one command idempotently', async () => {
    const calls: number[] = []
    const channel = new RuntimeControlChannel({
      generation: 2,
      handlers: {
        update: async value => {
          calls.push(value as number)
          return value
        }
      }
    })
    const command = { generation: 2, id: 'command-1', operation: 'update', value: 1 } as const
    const [first, replay] = await Promise.all([channel.apply(command), channel.apply(command)])
    expect(first).toEqual({ generation: 2, value: 1 })
    expect(replay).toBe(first)
    expect(calls).toEqual([1])
    await expect(channel.apply({ ...command, value: 2 })).rejects.toMatchObject({
      code: 'runtime_control.invalid_command'
    })
    await expect(channel.apply({ ...command, generation: 1, id: 'old' })).rejects.toMatchObject({
      code: 'runtime_control.generation_conflict'
    })
  })

  it('atomically replaces network rules without exposing the channel as a global', async () => {
    const store = new NetworkMockRuleStore()
    const channel = new RuntimeControlChannel({
      generation: 0,
      handlers: { 'network.rules.replace': createNetworkRuleControlHandler(store) }
    })
    const result = await channel.apply({
      generation: 0,
      id: 'rules-1',
      operation: 'network.rules.replace',
      value: { expectedRevision: '0', rules: { mode: 'passthrough', rules: [] } }
    })
    expect(result.value).toMatchObject({ mode: 'passthrough', revision: '1' })
    channel.dispose()
    await expect(channel.apply({
      generation: 0,
      id: 'rules-2',
      operation: 'network.rules.replace',
      value: { rules: { mode: 'passthrough', rules: [] } }
    })).rejects.toMatchObject({ code: 'runtime_control.disposed' })
  })
})
