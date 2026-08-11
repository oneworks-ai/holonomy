import { describe, expect, it } from 'vitest'

import { RuntimeNativeHostRouter } from '../../../src/native-port/router.js'

import type {
  NativeCallToken,
  NativeDispatchContext,
  NativePort,
  NativePortEvent,
  NativePortEventSink,
  NativePortRequest,
  NativePortResourceEventSink,
  NativeProviderToken
} from '../../../src/native-port/types.js'

class RecordingPort implements NativePort {
  readonly calls: string[] = []
  cancel(callToken: NativeCallToken) {
    this.calls.push(`cancel:${callToken}`)
  }
  closeResource(owner: NativeCallToken, provider: NativeProviderToken) {
    this.calls.push(`close:${owner}:${provider}`)
  }
  dispatch(
    request: NativePortRequest,
    _context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    _resourceSink: NativePortResourceEventSink
  ) {
    this.calls.push(`dispatch:${request.module}`)
    sink({
      id: request.id,
      resources: [{ providerToken: 'provider:1' as NativeProviderToken, type: 'test.resource' }],
      type: 'result',
      value: { ok: true }
    })
  }
  dispose() {
    this.calls.push('dispose')
  }
  grantCredits(callToken: NativeCallToken, credits: number) {
    this.calls.push(`credit:${callToken}:${credits}`)
  }
}

const context = (token: string, capabilities: readonly string[] = []): NativeDispatchContext => ({
  authority: { capabilities, principal: 'router-test' },
  callToken: token as NativeCallToken,
  mode: 'result',
  resources: []
})

describe('runtime native host router', () => {
  it('routes calls and returned resources to one exact owner', async () => {
    const first = new RecordingPort()
    const second = new RecordingPort()
    const router = new RuntimeNativeHostRouter([
      { modules: ['host.network'], port: first },
      { modules: ['host.fs'], port: second }
    ])
    const events: NativePortEvent[] = []
    router.dispatch({ args: {}, id: '1', module: 'host.network', operation: 'test' }, context('call:1'), event => {
      events.push(event)
    }, () => {})
    await router.closeResource('call:1' as NativeCallToken, 'provider:1' as NativeProviderToken)
    await router.dispose()

    expect(events).toHaveLength(1)
    expect(first.calls).toEqual(['dispatch:host.network', 'close:call:1:provider:1', 'dispose'])
    expect(second.calls).toEqual(['dispose'])
  })

  it('rejects duplicate module owners and unsupported modules', () => {
    const port = new RecordingPort()
    expect(() =>
      new RuntimeNativeHostRouter([
        { modules: ['host.network'], port },
        { modules: ['host.network'], port }
      ])
    ).toThrow('Duplicate')
    const router = new RuntimeNativeHostRouter([{ modules: ['host.network'], port }])
    const events: NativePortEvent[] = []
    router.dispatch({ args: {}, id: '2', module: 'host.unknown', operation: 'test' }, context('call:2'), event => {
      events.push(event)
    }, () => {})
    expect(events).toEqual([{ error: { code: 'capability_unsupported' }, id: '2', type: 'error' }])
  })

  it('admits any required route capability before dispatching to the port', () => {
    const port = new RecordingPort()
    const router = new RuntimeNativeHostRouter([{
      modules: ['host.network'],
      port,
      requiredCapabilities: ['host.network.http', 'host.network.mock']
    }])
    const denied: NativePortEvent[] = []
    router.dispatch({ args: {}, id: '3', module: 'host.network', operation: 'open' }, context('call:3'), event => {
      denied.push(event)
    }, () => {})
    expect(denied).toEqual([{ error: { code: 'capability_unsupported' }, id: '3', type: 'error' }])
    expect(port.calls).toEqual([])

    router.dispatch(
      { args: {}, id: '4', module: 'host.network', operation: 'open' },
      context('call:4', ['host.network.mock']),
      () => {},
      () => {}
    )
    expect(port.calls).toEqual(['dispatch:host.network'])
  })
})
