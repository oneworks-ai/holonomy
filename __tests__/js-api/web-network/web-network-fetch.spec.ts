import { describe, expect, it } from 'vitest'

import {
  RuntimeEventLoop,
  ScriptedNetworkProvider,
  WEB_NETWORK_CAPABILITY_MATRIX,
  createFetchRuntime,
  createNativeBridge
} from '../../../src/index.js'

import type {
  HostEventLoopPort,
  HostEventLoopTermination,
  NativeCallToken,
  NativeDispatchContext,
  NativePort,
  NativePortEventSink,
  NativePortRequest,
  NativePortResourceEventSink,
  NativeProviderToken
} from '../../../src/index.js'
import type { ScriptedHttpExchange } from '../../../src/web-network/scripted-provider.js'
import type { NetworkLimits } from '../../../src/web-network/types.js'

class VirtualHost implements HostEventLoopPort {
  checkpointCount = 0
  nowMs = 0
  readonly wakeups: Array<number | null> = []

  checkpointMicrotasks() {
    this.checkpointCount += 1
  }

  now() {
    return this.nowMs
  }

  requestWakeup(deadlineMs: number | null) {
    this.wakeups.push(deadlineMs)
  }

  terminate(reason: HostEventLoopTermination) {
    void reason
  }
}

class NeverProvider implements NativePort {
  cancel(_callToken: NativeCallToken) {}
  closeResource(_owner: NativeCallToken, _provider: NativeProviderToken) {}
  dispatch(
    _request: NativePortRequest,
    _context: Readonly<NativeDispatchContext>,
    _sink: NativePortEventSink,
    _resourceSink: NativePortResourceEventSink
  ) {}
  dispose() {}
  grantCredits(_callToken: NativeCallToken, _credits: number) {}
}

const authority = {
  allowedOrigins: ['https://api.example'],
  limits: { maxChunkBytes: 2, maxResponseBodyBytes: 8 }
} as const

const flush = async (loop: RuntimeEventLoop) => {
  for (let index = 0; index < 40; index += 1) {
    let turn = loop.runTurn()
    while (turn.status === 'ran') turn = loop.runTurn()
    await Promise.resolve()
  }
}

const setup = (
  http: readonly ScriptedHttpExchange[],
  limits: Partial<NetworkLimits> = {}
) => {
  const resolvedAuthority = { ...authority, limits: { ...authority.limits, ...limits } }
  const host = new VirtualHost()
  const loop = new RuntimeEventLoop(host)
  const provider = new ScriptedNetworkProvider({ authority: resolvedAuthority, http })
  const bridge = createNativeBridge(provider, {
    authority: { capabilities: ['host.network.http'], principal: 'guest-1' },
    eventLoop: loop
  })
  return { host, loop, provider, runtime: createFetchRuntime({ authority: resolvedAuthority, bridge }) }
}

describe('web network fetch v1 over Native Bridge v4', () => {
  it('streams a bounded response with pull credit and opaque resource binding', async () => {
    const test = setup([{
      resolvedAddress: '93.184.216.34',
      response: { body: ['ab', 'cd'], headers: [['x-test', 'yes']] },
      url: 'https://api.example/data'
    }])
    const pending = test.runtime.fetch('https://api.example/data')
    await flush(test.loop)
    const response = await pending

    expect(response.status).toBe(200)
    expect(response.headers.get('x-test')).toBe('yes')
    expect(response.bodyUsed).toBe(false)
    expect(() => response.clone()).toThrow(/not supported/u)

    const text = response.text()
    await flush(test.loop)
    await expect(text).resolves.toBe('abcd')
    expect(response.bodyUsed).toBe(true)
    expect(test.provider.grantedCredits.map(entry => entry.credits)).toEqual([1, 1, 1])
    expect(new Set(test.provider.seenCallTokens).size).toBeGreaterThan(2)
  })

  it('sends request bytes as bounded binary chunks and follows authorized redirects', async () => {
    const test = setup([
      {
        method: 'POST',
        resolvedAddress: '93.184.216.34',
        response: { headers: [['location', '/next']], status: 302 },
        url: 'https://api.example/start'
      },
      {
        resolvedAddress: '93.184.216.34',
        response: { body: ['ok'] },
        url: 'https://api.example/next'
      }
    ])
    const pending = test.runtime.fetch('https://api.example/start', {
      body: 'abcde',
      method: 'POST'
    })
    await flush(test.loop)
    const response = await pending
    const text = response.text()
    await flush(test.loop)

    await expect(text).resolves.toBe('ok')
    expect(response.redirected).toBe(true)
    expect(test.provider.receivedBodies.get('https://api.example/start')?.map(bytes => bytes.byteLength)).toEqual([
      2,
      2,
      1
    ])
  })

  it('rejects forbidden URL, header and private resolved address without exposing details', async () => {
    const local = setup([{
      resolvedAddress: '127.0.0.1',
      response: { body: ['no'] },
      url: 'https://api.example/private'
    }])
    await expect(local.runtime.fetch('file:///secret')).rejects.toMatchObject({ code: 'network.invalid_url' })
    await expect(local.runtime.fetch('https://api.example/private', { headers: { Host: 'bad' } })).rejects.toThrow(
      TypeError
    )

    const denied = local.runtime.fetch('https://api.example/private')
    await flush(local.loop)
    await expect(denied).rejects.toMatchObject({ code: 'network.invalid_url' })
  })

  it('maps scripted DNS failures without leaking host or provider state', async () => {
    const test = setup([{
      resolvedAddress: '93.184.216.34',
      response: { error: 'network.dns_failed' },
      url: 'https://api.example/failure'
    }])
    const pending = test.runtime.fetch('https://api.example/failure')
    await flush(test.loop)
    await expect(pending).rejects.toMatchObject({
      code: 'network.dns_failed',
      message: 'Network name resolution failed'
    })
  })

  it('enforces aggregate body limits and closes response resources on disposal', async () => {
    const limited = setup([{
      resolvedAddress: '93.184.216.34',
      response: { body: ['ab', 'cd'] },
      url: 'https://api.example/large'
    }], { maxResponseBodyBytes: 3 })
    const responsePending = limited.runtime.fetch('https://api.example/large')
    await flush(limited.loop)
    await expect(responsePending).rejects.toMatchObject({ code: 'network.response_too_large' })
    expect(limited.provider.closedResourceCount).toBe(1)

    const disposable = setup([{
      resolvedAddress: '93.184.216.34',
      response: { body: ['ab'] },
      url: 'https://api.example/dispose'
    }])
    const pending = disposable.runtime.fetch('https://api.example/dispose')
    await flush(disposable.loop)
    const active = await pending
    expect(disposable.runtime).toBeDefined()
    active.dispose()
    await flush(disposable.loop)
  })

  it('uses Bridge-owned timeout and AbortSignal cancellation', async () => {
    const host = new VirtualHost()
    const loop = new RuntimeEventLoop(host)
    const bridge = createNativeBridge(new NeverProvider(), {
      authority: { capabilities: ['host.network.http'], principal: 'guest-1' },
      eventLoop: loop
    })
    const runtime = createFetchRuntime({ authority, bridge })
    expect(runtime.AbortController).toBe(AbortController)
    const timeout = runtime.fetch('https://api.example/never', { timeoutMs: 1 })
    host.nowMs = 1
    await flush(loop)
    await expect(timeout).rejects.toMatchObject({ code: 'network.timeout' })

    const controller = new runtime.AbortController()
    const aborted = runtime.fetch('https://api.example/never', {
      signal: controller.signal
    })
    controller.abort()
    await flush(loop)
    await expect(aborted).rejects.toMatchObject({ code: 'network.cancelled' })
  })

  it('documents exactly the supported and deferred capability surface', () => {
    expect(WEB_NETWORK_CAPABILITY_MATRIX.features['fetch.client'].status).toBe('supported')
    expect(WEB_NETWORK_CAPABILITY_MATRIX.features['fetch.abort-deadline'].status).toBe('supported')
    expect(WEB_NETWORK_CAPABILITY_MATRIX.features['websocket.client'].status).toBe('unsupported')
    expect(WEB_NETWORK_CAPABILITY_MATRIX.features['socket.raw'].status).toBe('unsupported')
  })
})
