import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { describe, it } from 'vitest'

import { InspectorCdpProxy } from '../inspector-proxy.mjs'

const requestEvent = requestId => ({
  headers: [['accept', 'application/json']],
  method: 'GET',
  requestId,
  timestampMs: 10,
  type: 'requestWillBeSent',
  url: 'https://example.test/profile'
})

describe('inspector CDP proxy', () => {
  it('proxies non-Network CDP and owns remapped Network events and response bodies', async () => {
    let upstream
    let closeCalls = 0
    const sent = []
    const transport = {
      close: () => closeCalls += 1,
      send: async message => ({ id: message.id, result: { upstream: true } }),
      subscribe: listener => {
        upstream = listener
        return () => undefined
      }
    }
    const proxy = new InspectorCdpProxy()
    proxy.configureEndpoint('http://127.0.0.1:49123')
    const attached = proxy.attach({
      inspector: { generation: 4, id: 'inspector_test', processId: 'process_test' },
      process: { generation: 4, id: 'process_test' },
      transport
    })
    assert.match(attached.devtoolsFrontendUrl, /js_app\.html/u)
    assert.doesNotMatch(attached.devtoolsFrontendUrl, /devtools_app/u)
    const target = new URL(attached.webSocketDebuggerUrl)
    const token = target.searchParams.get('access_token')
    assert.ok(token)
    const session = proxy.connectAuthorized('inspector_test', token, message => sent.push(message))
    assert.deepEqual(await session.receive({ id: 1, method: 'Network.enable' }), { id: 1, result: {} })
    assert.deepEqual(await session.receive({ id: 2, method: 'Runtime.enable' }), {
      id: 2,
      result: { upstream: true }
    })
    upstream({ method: 'Runtime.consoleAPICalled', params: {} })
    assert.equal(sent[0].method, 'Runtime.consoleAPICalled')

    assert.equal(proxy.emitDiagnostic('process_test', 4, requestEvent('bridge-secret')), true)
    proxy.emitDiagnostic('process_test', 4, {
      headers: [['content-type', 'application/json']],
      requestId: 'bridge-secret',
      source: 'mock',
      status: 200,
      statusText: 'OK',
      timestampMs: 10,
      type: 'responseReceived',
      url: 'https://example.test/profile'
    })
    proxy.emitDiagnostic('process_test', 4, {
      dataBase64: Buffer.from('hello').toString('base64'),
      dataLength: 5,
      requestId: 'bridge-secret',
      timestampMs: 11,
      type: 'dataReceived'
    })
    proxy.emitDiagnostic('process_test', 4, {
      requestId: 'bridge-secret',
      timestampMs: 12,
      totalBytes: 5,
      type: 'loadingFinished'
    })
    const publicId = sent.find(message => message.method === 'Network.requestWillBeSent').params.requestId
    assert.notEqual(publicId, 'bridge-secret')
    assert.deepEqual(sent.slice(1).map(message => message.method), [
      'Network.requestWillBeSent',
      'Network.requestWillBeSentExtraInfo',
      'Network.responseReceived',
      'Network.responseReceivedExtraInfo',
      'Network.dataReceived',
      'Network.loadingFinished'
    ])
    assert.deepEqual(
      sent.find(message => message.method === 'Network.requestWillBeSentExtraInfo').params.headers,
      { accept: 'application/json' }
    )
    assert.equal(
      sent.find(message => message.method === 'Network.responseReceived').params.response.holonomySource,
      'mock'
    )
    assert.deepEqual(
      await session.receive({
        id: 3,
        method: 'Network.getResponseBody',
        params: { requestId: publicId }
      }),
      { id: 3, result: { base64Encoded: true, body: 'aGVsbG8=' } }
    )
    proxy.closeProcess('process_test', 4)
    assert.equal(closeCalls, 1)
  })

  it('drops unavailable bodies and isolates a throwing DevTools sink from diagnostics', async () => {
    const proxy = new InspectorCdpProxy()
    proxy.configureEndpoint('http://127.0.0.1:49123')
    const attached = proxy.attach({
      inspector: { generation: 1, id: 'inspector_drop', processId: 'process_drop' },
      process: { generation: 1, id: 'process_drop' },
      transport: { close() {}, send: async message => ({ id: message.id, result: {} }) }
    })
    const token = new URL(attached.webSocketDebuggerUrl).searchParams.get('access_token')
    const session = proxy.connectAuthorized('inspector_drop', token, () => {
      throw new Error('sink failure')
    })
    await session.receive({ id: 1, method: 'Network.enable' })
    assert.equal(proxy.emitDiagnostic('process_drop', 1, requestEvent('private-id')), true)
    assert.equal(
      proxy.emitDiagnostic('process_drop', 1, {
        bodyUnavailable: true,
        dataLength: 1,
        requestId: 'private-id',
        timestampMs: 2,
        type: 'dataReceived'
      }),
      true
    )
    assert.equal(
      proxy.emitDiagnostic('process_drop', 1, {
        requestId: 'private-id',
        timestampMs: 3,
        totalBytes: 1,
        type: 'loadingFinished'
      }),
      true
    )
    assert.equal(proxy.emitDiagnostic('process_drop', 1, requestEvent('next-id')), true)
    await proxy.close()
  })

  it('keeps emitting diagnostics when response-body accumulation exceeds its quota', async () => {
    const sent = []
    const proxy = new InspectorCdpProxy({ maxResponseBodyBytes: 1 })
    proxy.configureEndpoint('http://127.0.0.1:49123')
    const attached = proxy.attach({
      inspector: { generation: 1, id: 'inspector_overflow', processId: 'process_overflow' },
      process: { generation: 1, id: 'process_overflow' },
      transport: { close() {}, send: async message => ({ id: message.id, result: {} }) }
    })
    const token = new URL(attached.webSocketDebuggerUrl).searchParams.get('access_token')
    const session = proxy.connectAuthorized('inspector_overflow', token, message => sent.push(message))
    await session.receive({ id: 1, method: 'Network.enable' })
    proxy.emitDiagnostic('process_overflow', 1, requestEvent('private-overflow'))
    proxy.emitDiagnostic('process_overflow', 1, {
      headers: [],
      requestId: 'private-overflow',
      source: 'real',
      status: 200,
      statusText: 'OK',
      timestampMs: 2,
      type: 'responseReceived',
      url: 'https://example.test/profile'
    })
    proxy.emitDiagnostic('process_overflow', 1, {
      dataBase64: Buffer.from('xx').toString('base64'),
      dataLength: 2,
      requestId: 'private-overflow',
      source: 'real',
      timestampMs: 3,
      type: 'dataReceived'
    })
    proxy.emitDiagnostic('process_overflow', 1, {
      requestId: 'private-overflow',
      source: 'real',
      timestampMs: 4,
      totalBytes: 2,
      type: 'loadingFinished'
    })
    assert.deepEqual(sent.map(message => message.method), [
      'Network.requestWillBeSent',
      'Network.requestWillBeSentExtraInfo',
      'Network.responseReceived',
      'Network.responseReceivedExtraInfo',
      'Network.dataReceived',
      'Network.loadingFinished'
    ])
    const requestId = sent[0].params.requestId
    assert.deepEqual(
      await session.receive({
        id: 2,
        method: 'Network.getResponseBody',
        params: { requestId }
      }),
      {
        error: { code: -32_000, message: 'Inspector operation failed' },
        id: 2
      }
    )
    await proxy.close()
  })
})
