import { describe, expect, it } from 'vitest'

import {
  NetworkDiagnosticsBuffer,
  NetworkMockRouter,
  NetworkMockRuleStore,
  NetworkRuleError,
  RuntimeEventLoop,
  ScriptedNetworkProvider,
  createFetchRuntime,
  createNativeBridge,
  emitNetworkDiagnostic
} from '../../../src/index.js'

import type { HostEventLoopPort, HostEventLoopTermination } from '../../../src/index.js'
import type { NetworkDiagnosticsEvent, NetworkMockRuleSet } from '../../../src/web-network/types.js'

class VirtualHost implements HostEventLoopPort {
  checkpointMicrotasks() {}
  now() {
    return 0
  }
  requestWakeup(_deadlineMs: number | null) {}
  terminate(_reason: HostEventLoopTermination) {}
}

const flush = async (loop: RuntimeEventLoop) => {
  for (let index = 0; index < 40; index += 1) {
    let turn = loop.runTurn()
    while (turn.status === 'ran') turn = loop.runTurn()
    await Promise.resolve()
  }
}

const rules = (): NetworkMockRuleSet => ({
  mode: 'failClosed',
  rules: [{
    action: { body: { kind: 'json', value: { ok: true } }, status: 201, type: 'respond' },
    id: 'create-item',
    lifetime: { maxMatches: 1 },
    match: {
      body: { kind: 'jsonSubset', value: { item: { enabled: true } } },
      headers: { entries: [['content-type', 'application/json']], mode: 'subset' },
      method: 'POST',
      origin: 'https://api.example',
      path: { op: 'exact', value: '/v1/items' },
      query: { entries: [['tag', 'a'], ['tag', 'b']], mode: 'exact' }
    },
    priority: 100
  }]
})

describe('network control contracts', () => {
  it('atomically replaces rules and matches method, URL, query, headers and body', () => {
    const store = new NetworkMockRuleStore()
    expect(store.replace(rules(), '0').revision).toBe('1')
    const request = {
      body: new TextEncoder().encode(JSON.stringify({ item: { enabled: true, name: 'x' } })),
      headers: [['content-type', 'application/json']] as const,
      method: 'POST',
      url: 'https://api.example/v1/items?tag=a&tag=b'
    }
    expect(store.match(request)).toMatchObject({ ruleId: 'create-item', revision: '1' })
    expect(store.match(request)).toMatchObject({ action: { code: 'unavailable', type: 'fail' } })
    expect(() => store.replace(rules(), '0')).toThrow(NetworkRuleError)
  })

  it('rejects plaintext sensitive-header rules', () => {
    const input = rules()
    input.rules[0]!.match.headers = {
      entries: [['authorization', 'Bearer secret']],
      mode: 'subset'
    }
    expect(() => new NetworkMockRuleStore().replace(input)).toThrow('Invalid network rule set')
  })

  it('matches sensitive headers by presence or trusted digest without retaining plaintext rules', () => {
    const store = new NetworkMockRuleStore()
    store.replace({
      mode: 'failClosed',
      rules: [{
        action: { status: 204, type: 'respond' },
        id: 'authenticated',
        match: {
          headers: {
            entries: [
              ['authorization', '<present>'],
              ['cookie', `sha256:${'a'.repeat(64)}`]
            ],
            mode: 'subset'
          }
        },
        priority: 1
      }]
    })
    expect(store.match({
      body: new Uint8Array(),
      headers: [['authorization', 'Bearer private'], ['cookie', 'private=value']],
      method: 'GET',
      sensitiveHeaderSha256: [['cookie', 'a'.repeat(64)]],
      url: 'https://api.example/'
    })).toMatchObject({ ruleId: 'authenticated' })
  })

  it('keeps diagnostics bounded and isolates sink failures', () => {
    const buffer = new NetworkDiagnosticsBuffer({ maxBytes: 1024, maxEvents: 2 })
    const event = (requestId: string): NetworkDiagnosticsEvent => ({
      requestId,
      source: 'real',
      timestampMs: 1,
      totalBytes: 0,
      type: 'loadingFinished'
    })
    buffer.emit(event('1'))
    buffer.emit(event('2'))
    buffer.emit(event('3'))
    expect(buffer.snapshot().events.map(item => item.requestId)).toEqual(['2', '3'])
    expect(buffer.snapshot().dropped).toBe(1)
    expect(() =>
      emitNetworkDiagnostic({
        emit: () => {
          throw new Error('observer secret')
        }
      }, event('4'))
    ).not.toThrow()
  })

  it('emits redacted, ordered Fetch diagnostics with one terminal', async () => {
    const authority = { allowedOrigins: ['https://api.example'], limits: { maxChunkBytes: 8 } }
    const provider = new ScriptedNetworkProvider({
      authority,
      http: [{
        resolvedAddress: '93.184.216.34',
        response: { body: ['ok'], headers: [['set-cookie', 'secret']] },
        url: 'https://api.example/data?token=secret'
      }]
    })
    const loop = new RuntimeEventLoop(new VirtualHost())
    const bridge = createNativeBridge(provider, {
      authority: { capabilities: ['host.network.http'], principal: 'diagnostics-test' },
      eventLoop: loop
    })
    const diagnostics = new NetworkDiagnosticsBuffer()
    let timestamp = 10
    const runtime = createFetchRuntime({
      authority,
      bridge,
      diagnostics,
      diagnosticsBodyLimitBytes: 2,
      diagnosticsNow: () => timestamp++
    })
    const pending = runtime.fetch('https://api.example/data?token=secret', {
      headers: { authorization: 'Bearer secret' }
    })
    await flush(loop)
    const response = await pending
    const body = response.text()
    await flush(loop)
    await expect(body).resolves.toBe('ok')

    const events = diagnostics.snapshot().events
    expect(events.map(event => event.type)).toEqual([
      'requestWillBeSent',
      'responseReceived',
      'dataReceived',
      'loadingFinished'
    ])
    expect(events.map(event => event.timestampMs)).toEqual([10, 11, 12, 13])
    expect(events[0]).toMatchObject({ hasPostData: false, headers: [['authorization', '<redacted>']] })
    expect((events[0] as { url: string }).url).not.toContain('secret')
    expect(events[1]).toMatchObject({ headers: [], source: 'real' })
    expect(events[2]).toMatchObject({ dataBase64: 'b2s=', dataLength: 2, source: 'real' })
  })

  it('keeps one diagnostic request id across redirects and describes the prior response', async () => {
    const authority = { allowedOrigins: ['https://api.example'] }
    const provider = new ScriptedNetworkProvider({
      authority,
      http: [{
        resolvedAddress: '93.184.216.34',
        response: { headers: [['location', '/final']], status: 302 },
        url: 'https://api.example/start'
      }, {
        resolvedAddress: '93.184.216.34',
        response: { body: ['done'] },
        url: 'https://api.example/final'
      }]
    })
    const loop = new RuntimeEventLoop(new VirtualHost())
    const bridge = createNativeBridge(provider, {
      authority: { capabilities: ['host.network.http'], principal: 'redirect-test' },
      eventLoop: loop
    })
    const diagnostics = new NetworkDiagnosticsBuffer()
    const pending = createFetchRuntime({ authority, bridge, diagnostics }).fetch('https://api.example/start')
    await flush(loop)
    const response = await pending
    const body = response.text()
    await flush(loop)
    await expect(body).resolves.toBe('done')
    const starts = diagnostics.snapshot().events.filter(event => event.type === 'requestWillBeSent')
    expect(starts).toHaveLength(2)
    expect(starts[0]!.requestId).toBe(starts[1]!.requestId)
    expect(starts[1]).toMatchObject({
      hop: 1,
      redirectResponse: { source: 'real', status: 302, url: 'https://api.example/start' },
      url: 'https://api.example/final'
    })
  })

  it('emits one failure terminal when the provider body terminal is malformed', async () => {
    const authority = { allowedOrigins: ['https://api.example'] }
    const provider = new ScriptedNetworkProvider({
      authority,
      http: [{
        resolvedAddress: '93.184.216.34',
        response: { body: ['x'], extraResources: ['read-end'] },
        url: 'https://api.example/malformed'
      }]
    })
    const loop = new RuntimeEventLoop(new VirtualHost())
    const bridge = createNativeBridge(provider, {
      authority: { capabilities: ['host.network.http'], principal: 'malformed-test' },
      eventLoop: loop
    })
    const diagnostics = new NetworkDiagnosticsBuffer()
    const pending = createFetchRuntime({ authority, bridge, diagnostics }).fetch('https://api.example/malformed')
    await flush(loop)
    const response = await pending
    const body = response.text()
    await flush(loop)
    await expect(body).rejects.toMatchObject({ code: 'network.protocol_error' })
    expect(
      diagnostics.snapshot().events.filter(event => (
        event.type === 'loadingFailed' || event.type === 'loadingFinished'
      ))
    ).toEqual([expect.objectContaining({ type: 'loadingFailed' })])
  })

  it('serves a body-aware mock and preserves the real provider passthrough lifecycle', async () => {
    const authority = { allowedOrigins: ['https://api.example'] }
    const real = new ScriptedNetworkProvider({
      authority,
      http: [{
        resolvedAddress: '93.184.216.34',
        response: { body: ['real'] },
        url: 'https://api.example/real'
      }]
    })
    const receivedResourceReferences: string[] = []
    const dispatchReal = real.dispatch.bind(real)
    real.dispatch = (request, context, sink, resourceSink) => {
      for (const binding of context.resources) {
        receivedResourceReferences.push(binding.reference.resource)
        if (!/^resource:\d{1,10}$/u.test(binding.reference.resource)) {
          sink({ error: { code: 'invalid_request' }, id: request.id, type: 'error' })
          return
        }
      }
      return dispatchReal(request, context, sink, resourceSink)
    }
    const router = new NetworkMockRouter({
      authority,
      initialRules: {
        mode: 'passthrough',
        rules: [{
          action: { body: { kind: 'utf8', value: 'mocked' }, status: 200, type: 'respond' },
          id: 'body-match',
          match: {
            body: { kind: 'jsonSubset', value: { enabled: true } },
            method: 'POST',
            path: { op: 'exact', value: '/mock' }
          },
          priority: 1
        }]
      },
      passthrough: real
    })
    const loop = new RuntimeEventLoop(new VirtualHost())
    const bridge = createNativeBridge(router, {
      authority: { capabilities: ['host.network.http'], principal: 'mock-test' },
      eventLoop: loop
    })
    const diagnostics = new NetworkDiagnosticsBuffer()
    const runtime = createFetchRuntime({ authority, bridge, diagnostics })

    const mockedPending = runtime.fetch('https://api.example/mock', {
      body: JSON.stringify({ enabled: true, extra: 1 }),
      method: 'POST'
    })
    await flush(loop)
    const mocked = await mockedPending
    const mockedText = mocked.text()
    await flush(loop)
    await expect(mockedText).resolves.toBe('mocked')
    expect(real.receivedRequests).toEqual([])

    const realPending = runtime.fetch('https://api.example/real')
    await flush(loop)
    const response = await realPending
    const realText = response.text()
    await flush(loop)
    await expect(realText).resolves.toBe('real')
    expect(real.receivedRequests).toHaveLength(1)
    expect(receivedResourceReferences).not.toHaveLength(0)
    expect(receivedResourceReferences.every(reference => /^resource:\d{1,10}$/u.test(reference))).toBe(true)
    expect(
      diagnostics.snapshot().events.filter(event => event.type === 'responseReceived').map(event => (
        event.source
      ))
    ).toEqual(['mock', 'real'])
    runtime.dispose()
  })

  it('serves mock-only traffic without dispatching passthrough to the real provider', async () => {
    const authority = { allowedOrigins: ['https://api.example'] }
    const real = new ScriptedNetworkProvider({ authority, http: [] })
    const router = new NetworkMockRouter({
      authority,
      initialRules: {
        mode: 'failClosed',
        rules: [{
          action: { body: { kind: 'utf8', value: 'mock-only' }, status: 200, type: 'respond' },
          id: 'mock-only',
          match: { method: 'GET', path: { op: 'exact', value: '/mock' } },
          priority: 1
        }]
      },
      passthrough: real
    })
    const loop = new RuntimeEventLoop(new VirtualHost())
    const bridge = createNativeBridge(router, {
      authority: { capabilities: ['host.network.mock'], principal: 'mock-only-test' },
      eventLoop: loop
    })
    const runtime = createFetchRuntime({ authority, bridge })
    const pending = runtime.fetch('https://api.example/mock')
    await flush(loop)
    const response = await pending
    const text = response.text()
    await flush(loop)
    await expect(text).resolves.toBe('mock-only')
    expect(real.receivedRequests).toEqual([])

    router.rules.replace({
      mode: 'failClosed',
      rules: [{
        action: { type: 'passthrough' },
        id: 'forbidden-passthrough',
        match: { method: 'GET' },
        priority: 1
      }]
    })
    const forbidden = runtime.fetch('https://api.example/real')
    await flush(loop)
    await expect(forbidden).rejects.toMatchObject({ code: 'network.invalid_url' })
    expect(real.receivedRequests).toEqual([])
    runtime.dispose()
  })

  it('matches large request bodies by a chunked digest without a contiguous matching copy', async () => {
    const digest = 'a'.repeat(64)
    const authority = {
      allowedOrigins: ['https://api.example'],
      limits: { maxChunkBytes: 256 * 1024, maxRequestBodyBytes: 2 * 1024 * 1024 }
    }
    const real = new ScriptedNetworkProvider({ authority, http: [] })
    const observedChunks: number[] = []
    const router = new NetworkMockRouter({
      authority,
      bodySha256Chunks: chunks => {
        observedChunks.push(...chunks.map(chunk => chunk.byteLength))
        return digest
      },
      initialRules: {
        mode: 'failClosed',
        rules: [{
          action: { body: { kind: 'utf8', value: 'large-mock' }, status: 200, type: 'respond' },
          id: 'large-sha',
          match: { body: { kind: 'sha256', value: digest }, method: 'POST' },
          priority: 1
        }]
      },
      passthrough: real
    })
    const loop = new RuntimeEventLoop(new VirtualHost())
    const bridge = createNativeBridge(router, {
      authority: { capabilities: ['host.network.http'], principal: 'large-sha-test' },
      eventLoop: loop
    })
    const runtime = createFetchRuntime({ authority, bridge })
    const body = 'x'.repeat(1024 * 1024 + 1)
    const pending = runtime.fetch('https://api.example/large', { body, method: 'POST' })
    await flush(loop)
    const response = await pending
    const text = response.text()
    await flush(loop)
    await expect(text).resolves.toBe('large-mock')
    expect(observedChunks.length).toBeGreaterThan(1)
    expect(observedChunks.reduce((sum, length) => sum + length, 0)).toBe(body.length)
    expect(real.receivedRequests).toEqual([])
    runtime.dispose()
  })
})
