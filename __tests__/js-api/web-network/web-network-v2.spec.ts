/* eslint-disable max-lines -- security review counterexamples stay together as an executable contract. */

import { describe, expect, it } from 'vitest'

import {
  RuntimeEventLoop,
  ScriptedNetworkProvider,
  WEB_NETWORK_OPERATIONS,
  WebRequest,
  WebResponse,
  authorizeResolvedAddress,
  createFetchRuntime,
  createNativeBridge,
  resolveNetworkAuthority
} from '../../../src/index.js'

import type {
  HostEventLoopPort,
  HostEventLoopTermination,
  NativeArgumentValue,
  NativeCallToken,
  NativeDispatchContext,
  NativePort,
  NativePortEvent,
  NativePortEventSink,
  NativePortRequest,
  NativePortResourceBinding,
  NativePortResourceEventSink,
  NativeProviderToken
} from '../../../src/index.js'
import type { ScriptedHttpExchange } from '../../../src/web-network/scripted-provider.js'
import type { NetworkAuthority, NetworkLimits } from '../../../src/web-network/types.js'

class VirtualHost implements HostEventLoopPort {
  nowMs = 0

  checkpointMicrotasks() {}

  now() {
    return this.nowMs
  }

  requestWakeup(deadlineMs: number | null) {
    void deadlineMs
  }

  terminate(reason: HostEventLoopTermination) {
    void reason
  }
}

class PendingProvider implements NativePort {
  cancelCount = 0
  dispatchCount = 0

  cancel(callToken: NativeCallToken) {
    this.cancelCount += 1
    void callToken
  }

  closeResource(owner: NativeCallToken, provider: NativeProviderToken) {
    void owner
    void provider
  }

  dispatch(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    resourceSink: NativePortResourceEventSink
  ) {
    this.dispatchCount += 1
    void request
    void context
    void sink
    void resourceSink
  }

  dispose() {}

  grantCredits(callToken: NativeCallToken, credits: number) {
    void callToken
    void credits
  }
}

class ExtraGrantProvider implements NativePort {
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
      id: request.id,
      resources: [
        { providerToken: 'extra:1' as NativeProviderToken, type: 'network.http' },
        { providerToken: 'extra:2' as NativeProviderToken, type: 'network.http' }
      ],
      type: 'result',
      value: { ok: true, value: { accepted: true } }
    })
    void context
    void resourceSink
  }

  dispose() {}

  grantCredits(callToken: NativeCallToken, credits: number) {
    void callToken
    void credits
  }
}

const baseAuthority = {
  allowedOrigins: ['https://api.example']
} as const satisfies NetworkAuthority

const flush = async (loop: RuntimeEventLoop) => {
  for (let index = 0; index < 50; index += 1) {
    let turn = loop.runTurn()
    while (turn.status === 'ran') turn = loop.runTurn()
    await Promise.resolve()
  }
}

const createBridge = (provider: NativePort) => {
  const host = new VirtualHost()
  const loop = new RuntimeEventLoop(host)
  const bridge = createNativeBridge(provider, {
    authority: { capabilities: ['host.network.http'], principal: 'guest-v2' },
    eventLoop: loop
  })
  return { bridge, host, loop }
}

const setupFetch = (
  http: readonly ScriptedHttpExchange[],
  limits: Partial<NetworkLimits> = {},
  allowedOrigins: readonly string[] = baseAuthority.allowedOrigins
) => {
  const authority: NetworkAuthority = { allowedOrigins, limits }
  const provider = new ScriptedNetworkProvider({ authority, http })
  const test = createBridge(provider)
  return {
    ...test,
    provider,
    runtime: createFetchRuntime({ authority, bridge: test.bridge })
  }
}

let providerCall = 1

const dispatchProvider = (
  provider: ScriptedNetworkProvider,
  request: NativePortRequest,
  mode: 'result' | 'stream' = 'result',
  resources: readonly NativePortResourceBinding[] = []
) => {
  const events: NativePortEvent[] = []
  const callToken = `provider-test:${providerCall++}` as NativeCallToken
  provider.dispatch(
    request,
    {
      authority: { capabilities: ['host.network.http'], principal: 'provider-test' },
      callToken,
      mode,
      resources
    },
    event => events.push(event),
    event => void event
  )
  return { callToken, events }
}

const providerRequest = (
  id: string,
  args: NativeArgumentValue,
  operation: string = WEB_NETWORK_OPERATIONS.http.request,
  module = 'host.network'
) => ({ args, id, module, operation } as NativePortRequest)

const validProviderArgs = (url = 'https://api.example/data') => ({
  headers: [],
  method: 'GET',
  url
})

const readErrorCode = (event: NativePortEvent | undefined) => (
  event?.type === 'error' ? event.error.code : undefined
)

describe('web network Fetch v2 security and semantics', () => {
  it('provider independently validates module, operation, method and raw request headers', () => {
    const provider = new ScriptedNetworkProvider({
      authority: { ...baseAuthority, limits: { maxHeaders: 1 } },
      http: [{ resolvedAddress: '93.184.216.34', response: {}, url: 'https://api.example/data' }]
    })
    const cases: Array<[NativePortRequest, string]> = [
      [
        providerRequest('module', validProviderArgs(), WEB_NETWORK_OPERATIONS.http.request, 'host.fs'),
        'capability_unsupported'
      ],
      [providerRequest('operation', validProviderArgs(), 'v1.http.unknown'), 'operation_unsupported'],
      [providerRequest('method', { ...validProviderArgs(), method: 'get' }), 'invalid_request'],
      [providerRequest('host', { ...validProviderArgs(), headers: [['host', 'attacker']] }), 'invalid_request'],
      [
        providerRequest('duplicates', { ...validProviderArgs(), headers: [['x-a', '1'], ['x-a', '2']] }),
        'invalid_request'
      ]
    ]
    for (const [request, code] of cases) {
      expect(readErrorCode(dispatchProvider(provider, request).events[0])).toBe(code)
    }
    expect(provider.activeConnectionCount).toBe(0)
  })

  it('provider enforces open-write-finish-read-close ordering and aggregate upload bytes', () => {
    const provider = new ScriptedNetworkProvider({
      authority: { ...baseAuthority, limits: { maxChunkBytes: 2, maxRequestBodyBytes: 2 } },
      http: [{ resolvedAddress: '93.184.216.34', response: {}, url: 'https://api.example/data' }]
    })
    const opened = dispatchProvider(provider, providerRequest('request', validProviderArgs())).events[0]
    expect(opened?.type).toBe('result')
    if (opened?.type !== 'result' || opened.resources?.[0] == null) throw new Error('missing resource grant')
    const reference = { resource: 'opaque-test' }
    const binding: NativePortResourceBinding = {
      ownerCallToken: 'provider-owner' as NativeCallToken,
      providerToken: opened.resources[0].providerToken,
      reference,
      type: 'network.http'
    }
    const resourceRequest = (id: string, operation: string, binary?: Uint8Array) => ({
      args: { response: reference },
      ...(binary == null ? {} : { binary: [{ data: binary, handle: `${id}:body` }] }),
      id,
      module: 'host.network',
      operation
    } as NativePortRequest)

    expect(
      readErrorCode(
        dispatchProvider(provider, resourceRequest('early', WEB_NETWORK_OPERATIONS.http.finishBody), 'result', [
          binding
        ]).events[0]
      )
    ).toBe('invalid_request')
    expect(
      dispatchProvider(provider, resourceRequest('open', WEB_NETWORK_OPERATIONS.http.openBody), 'result', [binding])
        .events[0]?.type
    ).toBe('result')
    expect(
      dispatchProvider(
        provider,
        resourceRequest('write', WEB_NETWORK_OPERATIONS.http.writeBody, new Uint8Array([1, 2])),
        'result',
        [binding]
      ).events[0]?.type
    ).toBe('result')
    expect(
      readErrorCode(
        dispatchProvider(
          provider,
          resourceRequest('overflow', WEB_NETWORK_OPERATIONS.http.writeBody, new Uint8Array([3])),
          'result',
          [binding]
        ).events[0]
      )
    ).toBe('limit_exceeded')
    expect(
      dispatchProvider(provider, resourceRequest('finish', WEB_NETWORK_OPERATIONS.http.finishBody), 'result', [binding])
        .events[0]?.type
    ).toBe('result')
    expect(
      readErrorCode(
        dispatchProvider(provider, resourceRequest('again', WEB_NETWORK_OPERATIONS.http.finishBody), 'result', [
          binding
        ]).events[0]
      )
    ).toBe('invalid_request')
    expect(
      dispatchProvider(provider, resourceRequest('read', WEB_NETWORK_OPERATIONS.http.readBody), 'stream', [binding])
        .events
    ).toEqual([])
    expect(
      dispatchProvider(provider, resourceRequest('close', WEB_NETWORK_OPERATIONS.http.close), 'result', [binding])
        .events[0]?.type
    ).toBe('result')
    expect(provider.activeConnectionCount).toBe(0)
    expect(
      readErrorCode(
        dispatchProvider(provider, resourceRequest('late', WEB_NETWORK_OPERATIONS.http.finishBody), 'result', [binding])
          .events[0]
      )
    ).toBe('resource_invalid')
  })

  it('provider connection slots reject a second resource until terminal close', () => {
    const provider = new ScriptedNetworkProvider({
      authority: { ...baseAuthority, limits: { maxConcurrentConnections: 1 } },
      http: [
        { resolvedAddress: '93.184.216.34', response: {}, url: 'https://api.example/one' },
        { resolvedAddress: '93.184.216.34', response: {}, url: 'https://api.example/two' }
      ]
    })
    expect(
      dispatchProvider(provider, providerRequest('one', validProviderArgs('https://api.example/one'))).events[0]?.type
    ).toBe('result')
    expect(
      readErrorCode(
        dispatchProvider(provider, providerRequest('two', validProviderArgs('https://api.example/two'))).events[0]
      )
    ).toBe('limit_exceeded')
    expect(provider.activeConnectionCount).toBe(1)
  })

  it('runtime reserves a slot before pending admission and dispose drains Bridge state', async () => {
    const provider = new PendingProvider()
    const { bridge, loop } = createBridge(provider)
    const runtime = createFetchRuntime({
      authority: { ...baseAuthority, limits: { maxConcurrentConnections: 1 } },
      bridge
    })
    const first = runtime.fetch('https://api.example/one').catch(error => error as { code: string })
    await expect(runtime.fetch('https://api.example/two')).rejects.toMatchObject({ code: 'network.protocol_error' })
    expect(provider.dispatchCount).toBe(1)
    runtime.dispose()
    await flush(loop)
    await expect(first).resolves.toMatchObject({ code: 'network.cancelled' })
    expect(provider.cancelCount).toBe(1)
    expect(bridge.getSnapshot()).toMatchObject({ openResources: 0, pendingRequests: 0 })
  })

  it('closes every unexpected resource grant and leaves the Bridge snapshot empty', async () => {
    const provider = new ExtraGrantProvider()
    const { bridge, loop } = createBridge(provider)
    const runtime = createFetchRuntime({ authority: baseAuthority, bridge })
    const pending = runtime.fetch('https://api.example/grants')
    await flush(loop)
    await expect(pending).rejects.toMatchObject({ code: 'network.protocol_error' })
    await flush(loop)
    expect(provider.closeCount).toBe(2)
    expect(bridge.getSnapshot()).toMatchObject({ openResources: 0, pendingRequests: 0 })
  })

  it('cancels through the explicit Bridge channel with no ambient Abort globals', async () => {
    const names = ['AbortController', 'AbortSignal', 'EventTarget'] as const
    const descriptors = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
    for (const name of names) Reflect.deleteProperty(globalThis, name)
    try {
      const provider = new PendingProvider()
      const { bridge, loop } = createBridge(provider)
      const runtime = createFetchRuntime({ authority: baseAuthority, bridge })
      const controller = new runtime.AbortController()
      const pending = runtime.fetch('https://api.example/abort', { signal: controller.signal }).catch(error =>
        error as { code: string }
      )
      controller.abort()
      await flush(loop)
      await expect(pending).resolves.toMatchObject({ code: 'network.cancelled' })
      expect(provider.cancelCount).toBe(1)
      expect(bridge.getSnapshot().pendingRequests).toBe(0)
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor != null) Object.defineProperty(globalThis, name, descriptor)
      }
    }
  })

  it('accepts only strictly parsed resolved IP addresses unless private access is explicit', () => {
    const denied = resolveNetworkAuthority(baseAuthority)
    expect(authorizeResolvedAddress(denied, '93.184.216.34')).toBe('93.184.216.34')
    expect(authorizeResolvedAddress(denied, '2606:4700:4700::1111')).toContain('2606')
    for (
      const address of [
        'garbage',
        '127.0.0.1',
        '127.000.000.001',
        '0:0:0:0:0:0:0:1',
        '::ffff:7f00:1',
        'fe80::1%en0',
        '203.0.113.8'
      ]
    ) {
      expect(() => authorizeResolvedAddress(denied, address)).toThrow(/not authorized/u)
    }
    const allowed = resolveNetworkAuthority({ ...baseAuthority, privateNetwork: 'allow' })
    expect(authorizeResolvedAddress(allowed, '127.0.0.1')).toBe('127.0.0.1')
    expect(() => authorizeResolvedAddress(allowed, 'garbage')).toThrow(/not authorized/u)
  })

  it('applies redirect method/header rules and never sends URL fragments', async () => {
    const test = setupFetch(
      [
        {
          method: 'PUT',
          resolvedAddress: '93.184.216.34',
          response: { headers: [['location', 'https://other.example/next#secret']], status: 303 },
          url: 'https://api.example/start'
        },
        {
          resolvedAddress: '93.184.216.35',
          response: { body: ['ok'] },
          url: 'https://other.example/next'
        },
        {
          method: 'HEAD',
          resolvedAddress: '93.184.216.34',
          response: { headers: [['location', '/head-next#secret']], status: 303 },
          url: 'https://api.example/head'
        },
        {
          method: 'HEAD',
          resolvedAddress: '93.184.216.34',
          response: {},
          url: 'https://api.example/head-next'
        }
      ],
      {},
      ['https://api.example', 'https://other.example']
    )
    const redirected = test.runtime.fetch('https://api.example/start#initial', {
      body: 'payload',
      headers: {
        authorization: 'Bearer secret',
        'content-encoding': 'identity',
        'content-language': 'en',
        'content-location': '/source',
        'content-type': 'text/plain'
      },
      method: 'PUT'
    })
    await flush(test.loop)
    const response = await redirected
    const body = response.text()
    await flush(test.loop)
    await expect(body).resolves.toBe('ok')

    const head = test.runtime.fetch('https://api.example/head#initial', { method: 'HEAD' })
    await flush(test.loop)
    await expect(head).resolves.toMatchObject({ status: 200 })

    expect(test.provider.receivedRequests.map(request => [request.method, request.url])).toEqual([
      ['PUT', 'https://api.example/start'],
      ['GET', 'https://other.example/next'],
      ['HEAD', 'https://api.example/head'],
      ['HEAD', 'https://api.example/head-next']
    ])
    const secondNames = test.provider.receivedRequests[1]!.headers.map(([name]) => name)
    expect(secondNames).not.toContain('authorization')
    expect(secondNames.filter(name => name.startsWith('content-'))).toEqual([])
  })

  it('counts provider raw duplicate headers while allowing final outgoing request headers', async () => {
    const request = setupFetch([
      { resolvedAddress: '93.184.216.34', response: {}, url: 'https://api.example/request' }
    ], { maxHeaders: 1 })
    const accepted = request.runtime.fetch('https://api.example/request', {
      headers: [['x-repeat', 'one'], ['x-repeat', 'two']]
    })
    await flush(request.loop)
    await expect(accepted).resolves.toMatchObject({ status: 200 })
    expect(request.provider.receivedRequests[0]?.headers).toEqual([['x-repeat', 'one, two']])

    const response = setupFetch([{
      resolvedAddress: '93.184.216.34',
      response: { headers: [['x-repeat', 'one'], ['x-repeat', 'two']] },
      url: 'https://api.example/response'
    }], { maxHeaders: 1 })
    const pending = response.runtime.fetch('https://api.example/response')
    await flush(response.loop)
    await expect(pending).rejects.toMatchObject({ code: 'network.protocol_error' })
    expect(response.provider.activeConnectionCount).toBe(0)
  })

  it('enforces body lock, used, cancel and clone invariants', async () => {
    const locked = new WebResponse('abc')
    const firstReader = locked.body!.getReader()
    expect(() => locked.body!.getReader()).toThrow(/locked/u)
    expect(() => locked.clone()).toThrow(/locked/u)
    firstReader.releaseLock()
    expect(locked.clone()).toBeInstanceOf(WebResponse)

    const consumed = new WebResponse('abc')
    const reader = consumed.body!.getReader()
    const read = reader.read()
    expect(() => reader.releaseLock()).toThrow(/pending/u)
    await expect(read).resolves.toMatchObject({ done: false })
    reader.releaseLock()
    expect(() => reader.read()).toThrow(/released/u)
    expect(consumed.bodyUsed).toBe(true)
    expect(() => consumed.clone()).toThrow(/consumed/u)

    const cancelled = new WebResponse('abc')
    await cancelled.body!.cancel('test')
    expect(cancelled.bodyUsed).toBe(true)
    expect(() => cancelled.clone()).toThrow(/consumed/u)
  })

  it('requires absolute Request URLs, strips fragments and rejects bodies on HEAD/no-content responses', async () => {
    expect(() => new WebRequest('/relative')).toThrow(/absolute/u)
    expect(new WebRequest('https://api.example/path#secret').url).toBe('https://api.example/path')
    for (const status of [204, 205, 304]) {
      expect(() => new WebResponse('invalid', { status })).toThrow(/cannot have a body/u)
    }

    for (const [method, status] of [['GET', 204], ['GET', 205], ['GET', 304], ['HEAD', 200]] as const) {
      const test = setupFetch([{
        method,
        resolvedAddress: '93.184.216.34',
        response: { body: ['invalid'], status },
        url: `https://api.example/no-body-${method}-${status}`
      }])
      const pending = test.runtime.fetch(`https://api.example/no-body-${method}-${status}`, { method })
      await flush(test.loop)
      await expect(pending).rejects.toMatchObject({ code: 'network.protocol_error' })
    }
  })

  it('redacts malformed provider headers, locations and response URLs into stable errors', async () => {
    const cases: ScriptedHttpExchange[] = [
      {
        resolvedAddress: '93.184.216.34',
        response: { headers: [['bad\nname', 'value']] },
        url: 'https://api.example/bad-header'
      },
      {
        resolvedAddress: '93.184.216.34',
        response: { headers: [['location', 'http://[invalid']], status: 302 },
        url: 'https://api.example/bad-location'
      },
      {
        resolvedAddress: '93.184.216.34',
        response: { url: 'not a URL' },
        url: 'https://api.example/bad-url'
      }
    ]
    for (const exchange of cases) {
      const test = setupFetch([exchange])
      const pending = test.runtime.fetch(exchange.url)
      await flush(test.loop)
      await expect(pending).rejects.toMatchObject({ code: 'network.protocol_error' })
    }
  })
})
