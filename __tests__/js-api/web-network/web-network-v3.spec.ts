import { describe, expect, it } from 'vitest'

import {
  RuntimeEventLoop,
  ScriptedNetworkProvider,
  WebBodyController,
  WebHeaders,
  authorizeResolvedAddress,
  createFetchRuntime,
  createNativeBridge,
  resolveNetworkAuthority
} from '../../../src/index.js'

import type {
  HostEventLoopPort,
  HostEventLoopTermination,
  NativeCallToken,
  NativeDispatchContext,
  NativePort,
  NativePortEvent,
  NativePortEventSink,
  NativePortRequest,
  NativePortResourceEventSink,
  NativeProviderToken
} from '../../../src/index.js'
import type { ScriptedHttpExchange, ScriptedResourceGrantPhase } from '../../../src/web-network/scripted-provider.js'
import type { NetworkAuthority, NetworkLimits } from '../../../src/web-network/types.js'
import type { WebBodySource } from '../../../src/web-network/web-body.js'

class VirtualHost implements HostEventLoopPort {
  checkpointMicrotasks() {}

  now() {
    return 0
  }

  requestWakeup(deadlineMs: number | null) {
    void deadlineMs
  }

  terminate(reason: HostEventLoopTermination) {
    void reason
  }
}

class TerminalGrantProvider implements NativePort {
  closeCount = 0
  private sink?: NativePortEventSink
  private request?: NativePortRequest

  cancel(callToken: NativeCallToken) {
    void callToken
  }

  closeResource(owner: NativeCallToken, provider: NativeProviderToken) {
    this.closeCount += 1
    void owner
    void provider
  }

  dispatch(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    resourceSink: NativePortResourceEventSink
  ) {
    this.request = request
    this.sink = sink
    void context
    void resourceSink
  }

  dispose() {}

  grantCredits(callToken: NativeCallToken, credits: number) {
    void callToken
    void credits
  }

  completeRequest() {
    if (this.sink == null || this.request == null) throw new Error('request was not dispatched')
    this.sink({
      id: this.request.id,
      resources: [{ providerToken: 'terminal:resource' as NativeProviderToken, type: 'network.http' }],
      type: 'result',
      value: { ok: true, value: { accepted: true } }
    })
  }
}

class ErrorResourceProvider implements NativePort {
  closeCount = 0

  cancel(callToken: NativeCallToken) {
    void callToken
  }

  closeResource(owner: NativeCallToken, provider: NativeProviderToken) {
    this.closeCount += 1
    void owner
    void provider
  }

  dispatch(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    resourceSink: NativePortResourceEventSink
  ) {
    sink({
      error: { code: 'internal' },
      id: request.id,
      resources: [{ providerToken: 'illegal:error-resource' as NativeProviderToken, type: 'network.http' }],
      type: 'error'
    } as unknown as NativePortEvent)
    void context
    void resourceSink
  }

  dispose() {}

  grantCredits(callToken: NativeCallToken, credits: number) {
    void callToken
    void credits
  }
}

const authority = {
  allowedOrigins: ['https://api.example']
} as const satisfies NetworkAuthority

const flush = async (loop: RuntimeEventLoop) => {
  for (let index = 0; index < 50; index += 1) {
    let turn = loop.runTurn()
    while (turn.status === 'ran') turn = loop.runTurn()
    await Promise.resolve()
  }
}

const setup = (
  http: readonly ScriptedHttpExchange[],
  limits: Partial<NetworkLimits> = {}
) => {
  const host = new VirtualHost()
  const loop = new RuntimeEventLoop(host)
  const options: NetworkAuthority = { ...authority, limits }
  const provider = new ScriptedNetworkProvider({ authority: options, http })
  const bridge = createNativeBridge(provider, {
    authority: { capabilities: ['host.network.http'], principal: 'network-v3' },
    eventLoop: loop
  })
  return { bridge, loop, provider, runtime: createFetchRuntime({ authority: options, bridge }) }
}

const expectProtocolForExtraGrant = async (phase: ScriptedResourceGrantPhase) => {
  const test = setup([{
    method: 'POST',
    resolvedAddress: '93.184.216.34',
    response: { body: ['chunk'], extraResources: [phase] },
    url: `https://api.example/${phase}`
  }])
  const request = test.runtime.fetch(`https://api.example/${phase}`, { body: 'x', method: 'POST' })
  await flush(test.loop)
  if (phase === 'read-chunk' || phase === 'read-end') {
    const response = await request
    const body = response.text()
    await flush(test.loop)
    await expect(body).rejects.toMatchObject({ code: 'network.protocol_error' })
  } else {
    await expect(request).rejects.toMatchObject({ code: 'network.protocol_error' })
  }
  await flush(test.loop)
  expect(test.provider.closedResourceCount).toBe(2)
  expect(test.provider.activeConnectionCount).toBe(0)
  expect(test.bridge.getSnapshot()).toMatchObject({ openResources: 0, pendingRequests: 0 })
}

describe('web network Fetch v3 adversarial lifecycle regressions', () => {
  it('closes every unexpected grant for request, unary phases and read stream events', async () => {
    for (
      const phase of [
        'request',
        'open-body',
        'write-body',
        'finish-body',
        'read-chunk',
        'read-end'
      ] as const
    ) await expectProtocolForExtraGrant(phase)
  })

  it('retains the Native v5 malformed-error-resource integration expectation', async () => {
    const host = new VirtualHost()
    const loop = new RuntimeEventLoop(host)
    const provider = new ErrorResourceProvider()
    const bridge = createNativeBridge(provider, {
      authority: { capabilities: ['host.network.http'], principal: 'network-v3-error' },
      eventLoop: loop
    })
    const runtime = createFetchRuntime({ authority, bridge })
    const pending = runtime.fetch('https://api.example/error-resource')
    await flush(loop)
    await expect(pending).rejects.toMatchObject({ code: 'network.protocol_error' })
    expect(provider.closeCount).toBe(1)
    expect(bridge.getSnapshot()).toMatchObject({ openResources: 0, pendingRequests: 0 })
  })

  it('does not return a Response when dispose races terminal request delivery', async () => {
    const host = new VirtualHost()
    const loop = new RuntimeEventLoop(host)
    const provider = new TerminalGrantProvider()
    const bridge = createNativeBridge(provider, {
      authority: { capabilities: ['host.network.http'], principal: 'network-v3-dispose' },
      eventLoop: loop
    })
    const runtime = createFetchRuntime({ authority, bridge })
    const pending = runtime.fetch('https://api.example/dispose-race')
    provider.completeRequest()
    loop.runTurn()
    runtime.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'network.cancelled' })
    await flush(loop)
    expect(provider.closeCount).toBe(1)
    expect(bridge.getSnapshot()).toMatchObject({ openResources: 0, pendingRequests: 0 })
  })

  it('enforces provider response chunk and aggregate limits once before streaming', async () => {
    for (
      const [url, body, limits] of [
        ['chunk-limit', ['abc'], { maxChunkBytes: 2, maxResponseBodyBytes: 4 }],
        ['aggregate-limit', ['ab', 'cd'], { maxChunkBytes: 2, maxResponseBodyBytes: 3 }]
      ] as const
    ) {
      const test = setup([{
        resolvedAddress: '93.184.216.34',
        response: { body },
        url: `https://api.example/${url}`
      }], limits)
      const pending = test.runtime.fetch(`https://api.example/${url}`)
      await flush(test.loop)
      await expect(pending).rejects.toMatchObject({ code: 'network.response_too_large' })
      await flush(test.loop)
      expect(test.provider.closedResourceCount).toBe(1)
      expect(test.provider.cancelCount).toBe(0)
      expect(test.provider.activeConnectionCount).toBe(0)
    }
  })

  it('rejects late stream chunks after Response cancellation with a stable cancellation error', async () => {
    const test = setup([{
      resolvedAddress: '93.184.216.34',
      response: { body: ['late'] },
      url: 'https://api.example/late-chunk'
    }])
    const pending = test.runtime.fetch('https://api.example/late-chunk')
    await flush(test.loop)
    const response = await pending
    const read = response.body!.getReader().read()
    response.dispose()
    response.dispose()
    await flush(test.loop)
    await expect(read).rejects.toMatchObject({ code: 'network.cancelled' })
    expect(test.provider.cancelCount).toBe(1)
    expect(test.provider.closedResourceCount).toBe(1)
    expect(test.bridge.getSnapshot()).toMatchObject({ openResources: 0, pendingRequests: 0 })
  })

  it('drops source values when cancellation wins at pending and terminal microtask positions', async () => {
    let resolvePending: ((value: Uint8Array) => void) | undefined
    const pendingSource: WebBodySource = {
      cancel() {},
      pull: () =>
        new Promise<Uint8Array>(resolve => {
          resolvePending = resolve
        })
    }
    const pendingController = new WebBodyController(pendingSource)
    const pendingRead = pendingController.stream.getReader().read()
    pendingController.cancel('before_source_resolves')
    resolvePending?.(new Uint8Array([1]))
    await expect(pendingRead).rejects.toMatchObject({ code: 'network.cancelled' })

    let terminalController: WebBodyController
    const terminalSource: WebBodySource = {
      cancel() {},
      async pull() {
        await Promise.resolve()
        queueMicrotask(() => terminalController.cancel('terminal_before_continuation'))
        return new Uint8Array([2])
      }
    }
    terminalController = new WebBodyController(terminalSource)
    const terminalRead = terminalController.stream.getReader().read()
    await expect(terminalRead).rejects.toMatchObject({ code: 'network.cancelled' })
  })

  it('fails closed for IPv6 registry special-use, reserved and malformed addresses', () => {
    const resolved = resolveNetworkAuthority(authority)
    expect(authorizeResolvedAddress(resolved, '2606:4700:4700::1111')).toContain('2606')
    for (
      const address of [
        '3fff::1',
        '2001:db8::1',
        '2001:10::1',
        '2001:20::1',
        '2001:2::1',
        '100::1',
        'fc00::1',
        'fe80::1',
        '::1',
        '::ffff:7f00:1',
        '::ffff:0808:0808',
        '2001:::1',
        'fe80::1%en0'
      ]
    ) {
      expect(() => authorizeResolvedAddress(resolved, address)).toThrow(/not authorized/u)
    }
  })

  it('uses only final outgoing headers after set/delete mutation', async () => {
    const headers = new WebHeaders([['x-first', 'one'], ['x-remove', 'old']])
    headers.append('x-first', 'two')
    headers.set('x-first', 'final')
    headers.delete('x-remove')
    const test = setup([{
      resolvedAddress: '93.184.216.34',
      response: {},
      url: 'https://api.example/final-headers'
    }], { maxHeaders: 1 })
    const pending = test.runtime.fetch('https://api.example/final-headers', { headers })
    await flush(test.loop)
    await expect(pending).resolves.toMatchObject({ status: 200 })
    expect(test.provider.receivedRequests[0]?.headers).toEqual([['x-first', 'final']])
  })
})
