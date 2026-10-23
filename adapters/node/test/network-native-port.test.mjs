import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- This adapter is verified with Node's public test runner.
import test from 'node:test'

import { NodeNetworkNativePort } from '../src/node-network-native-port.mjs'

const request = id => ({
  args: { headers: [], method: 'GET', url: 'https://example.test/' },
  id,
  module: 'host.network',
  operation: 'v1.http.request'
})

const context = callToken => ({
  authority: { capabilities: ['host.network.http'], principal: 'test' },
  callToken,
  mode: 'result',
  resources: []
})

const settle = () => new Promise(resolve => setImmediate(resolve))

const openExchange = (port, id) => {
  const opened = []
  const response = { resource: `response:${id}` }
  const ownerCallToken = `owner:${id}`
  port.dispatch(request(`request:${id}`), context(ownerCallToken), event => opened.push(event), () => {})
  const providerToken = opened[0].resources[0].providerToken
  const binding = { ownerCallToken, providerToken, reference: response, type: 'network.http' }
  port.dispatch(
    { args: { response }, id: `open:${id}`, module: 'host.network', operation: 'v1.http.open-body' },
    { ...context(`open:${id}`), resources: [binding] },
    () => {},
    () => {}
  )
  return { binding, ownerCallToken, providerToken, response }
}

const finishExchange = (port, id, exchange, sink) =>
  port.dispatch(
    {
      args: { response: exchange.response },
      id: `finish:${id}`,
      module: 'host.network',
      operation: 'v1.http.finish-body'
    },
    { ...context(`finish-call:${id}`), resources: [exchange.binding] },
    sink,
    () => {}
  )

const readExchange = (port, id, exchange, sink) => {
  const callToken = `read-call:${id}`
  port.dispatch(
    {
      args: { response: exchange.response },
      id: `read:${id}`,
      module: 'host.network',
      operation: 'v1.http.read-body'
    },
    { ...context(callToken), mode: 'stream', resources: [exchange.binding] },
    sink,
    () => {}
  )
  return callToken
}

test('revokes live provider grants exactly once on provider disposal', () => {
  const port = new NodeNetworkNativePort({ request: async () => undefined })
  const results = []
  const revokes = []

  port.dispatch(request('one'), context('call:one'), event => results.push(event), event => revokes.push(event))
  port.dispose()
  port.dispose()

  assert.equal(results.length, 1)
  assert.equal(results[0].resources.length, 1)
  assert.deepEqual(revokes, [{ providerToken: results[0].resources[0].providerToken, type: 'revoke' }])
})

test('does not revoke a resource already closed by its exact owner', () => {
  const port = new NodeNetworkNativePort({ request: async () => undefined })
  const results = []
  const revokes = []
  port.dispatch(request('two'), context('call:two'), event => results.push(event), event => revokes.push(event))
  const providerToken = results[0].resources[0].providerToken

  port.closeResource('wrong-owner', providerToken)
  port.closeResource('call:two', providerToken)
  port.dispose()

  assert.deepEqual(revokes, [])
})

test('preserves typed transport failures instead of collapsing them to unavailable', async () => {
  for (
    const [source, expected] of [
      ['aborted', { code: 'cancelled' }],
      ['timeout', { code: 'timeout', domain: 'network' }],
      ['connection_refused', { code: 'connection_refused', domain: 'network' }],
      ['protocol_error', { code: 'protocol_error' }]
    ]
  ) {
    const port = new NodeNetworkNativePort({
      request: async () => {
        throw Object.assign(new Error('typed transport failure'), { code: source })
      }
    })
    const events = []
    const first = []
    const response = { resource: 'response' }
    port.dispatch(request(`request:${source}`), context(`call:${source}`), event => first.push(event), () => {})
    const providerToken = first[0].resources[0].providerToken
    port.dispatch(
      {
        args: { response },
        id: `open:${source}`,
        module: 'host.network',
        operation: 'v1.http.open-body'
      },
      {
        ...context(`open:${source}`),
        resources: [{
          ownerCallToken: `call:${source}`,
          providerToken,
          reference: response,
          type: 'network.http'
        }]
      },
      () => {},
      () => {}
    )
    await port.dispatch(
      {
        args: { response },
        id: `finish:${source}`,
        module: 'host.network',
        operation: 'v1.http.finish-body'
      },
      {
        ...context(`call:${source}`),
        resources: [{
          ownerCallToken: `call:${source}`,
          providerToken,
          reference: response,
          type: 'network.http'
        }]
      },
      event => events.push(event),
      () => {}
    )
    assert.deepEqual(events, [{ error: expected, id: `finish:${source}`, type: 'error' }])
  }
})

test('uses the closed Network failure envelope for an upstream response cap', async () => {
  const port = new NodeNetworkNativePort({
    request: async () => {
      throw Object.assign(new Error('response cap'), { code: 'response_too_large' })
    }
  })
  const first = []
  const response = { resource: 'response' }
  port.dispatch(request('request:cap'), context('call:cap'), event => first.push(event), () => {})
  const providerToken = first[0].resources[0].providerToken
  const binding = {
    ownerCallToken: 'call:cap',
    providerToken,
    reference: response,
    type: 'network.http'
  }
  port.dispatch(
    { args: { response }, id: 'open:cap', module: 'host.network', operation: 'v1.http.open-body' },
    {
      ...context('open:cap'),
      resources: [binding]
    },
    () => {},
    () => {}
  )
  const events = []
  await port.dispatch(
    { args: { response }, id: 'finish:cap', module: 'host.network', operation: 'v1.http.finish-body' },
    {
      ...context('call:cap'),
      resources: [binding]
    },
    event => events.push(event),
    () => {}
  )
  assert.deepEqual(events, [{
    id: 'finish:cap',
    type: 'result',
    value: { error: 'network.response_too_large', ok: false }
  }])
})

test('does not pull an AsyncIterable response before credits and bounds pulls by credits', async () => {
  let pulls = 0
  const chunks = [Uint8Array.from([1]), Uint8Array.from([2, 3])]
  const body = {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      const value = chunks[pulls]
      pulls += 1
      return value == null ? { done: true, value: undefined } : { done: false, value }
    }
  }
  const port = new NodeNetworkNativePort({
    request: async () => ({ body, headers: [], status: 200, statusText: 'OK', url: 'https://example.test/' })
  }, { maxChunkBytes: 2 })
  const exchange = openExchange(port, 'stream')
  const head = []
  await finishExchange(port, 'stream', exchange, event => head.push(event))
  assert.equal(head[0].value.value.hasBody, true)
  assert.equal(pulls, 0)

  const events = []
  const callToken = readExchange(port, 'stream', exchange, event => events.push(event))
  assert.equal(pulls, 0)
  port.grantCredits(callToken, 2)
  await settle()
  assert.equal(pulls, 2)
  assert.deepEqual(events.map(event => [...event.binary[0].data]), [[1], [2, 3]])

  port.grantCredits(callToken, 1)
  await settle()
  assert.equal(pulls, 3)
  assert.equal(events[2].type, 'end')
})

test('reader cancellation returns an in-flight upstream once and ignores its late chunk', async () => {
  let finishPull
  let pulls = 0
  let returns = 0
  const body = {
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      pulls += 1
      return new Promise(resolve => {
        finishPull = resolve
      })
    },
    async return() {
      returns += 1
      return { done: true, value: undefined }
    }
  }
  const port = new NodeNetworkNativePort({
    request: async () => ({ body, headers: [], status: 200, statusText: 'OK', url: 'https://example.test/' })
  })
  const exchange = openExchange(port, 'cancel')
  await finishExchange(port, 'cancel', exchange, () => {})
  const events = []
  const callToken = readExchange(port, 'cancel', exchange, event => events.push(event))
  port.grantCredits(callToken, 1)
  await settle()
  assert.equal(pulls, 1)
  port.cancel(callToken)
  await settle()
  assert.equal(returns, 1)
  finishPull({ done: false, value: Uint8Array.from([9]) })
  await settle()
  assert.deepEqual(events, [])
  port.closeResource(exchange.ownerCallToken, exchange.providerToken)
  await settle()
  assert.equal(returns, 1)
})

test('accepts a Host reader body and terminates oversized chunks as protocol errors', async () => {
  let cancels = 0
  const body = {
    getReader() {
      return {
        async cancel() {
          cancels += 1
        },
        async read() {
          return { done: false, value: new Uint8Array(3) }
        },
        releaseLock() {}
      }
    }
  }
  const port = new NodeNetworkNativePort({
    request: async () => ({ body, headers: [], status: 200, statusText: 'OK', url: 'https://example.test/' })
  }, { maxChunkBytes: 2 })
  const exchange = openExchange(port, 'reader')
  await finishExchange(port, 'reader', exchange, () => {})
  const events = []
  const callToken = readExchange(port, 'reader', exchange, event => events.push(event))
  port.grantCredits(callToken, 1)
  await settle()
  assert.deepEqual(events, [{ error: { code: 'protocol_error' }, id: 'read:reader', type: 'error' }])
  assert.equal(cancels, 1)
})

test('releases a real reader lock once on normal EOF and repeated cleanup', async () => {
  let releases = 0
  const stream = new ReadableStream({
    start(controller) {
      controller.close()
    }
  })
  const body = {
    getReader() {
      const reader = stream.getReader()
      return {
        cancel: reason => reader.cancel(reason),
        read: () => reader.read(),
        releaseLock() {
          releases += 1
          reader.releaseLock()
        }
      }
    }
  }
  const port = new NodeNetworkNativePort({
    request: async () => ({ body, headers: [], status: 200, statusText: 'OK', url: 'https://example.test/' })
  })
  const exchange = openExchange(port, 'reader-eof')
  await finishExchange(port, 'reader-eof', exchange, () => {})
  const events = []
  const callToken = readExchange(port, 'reader-eof', exchange, event => events.push(event))
  port.grantCredits(callToken, 1)
  await settle()
  assert.deepEqual(events.map(event => event.type), ['end'])
  assert.equal(releases, 1)
  port.cancel(callToken)
  port.closeResource(exchange.ownerCallToken, exchange.providerToken)
  port.closeResource(exchange.ownerCallToken, exchange.providerToken)
  await settle()
  assert.equal(releases, 1)
})

test('releases a real reader lock once when cancel rejects', async () => {
  let cancels = 0
  let releases = 0
  const stream = new ReadableStream()
  const body = {
    getReader() {
      const reader = stream.getReader()
      return {
        async cancel() {
          cancels += 1
          throw new Error('cancel failed')
        },
        read: () => reader.read(),
        releaseLock() {
          releases += 1
          reader.releaseLock()
        }
      }
    }
  }
  const port = new NodeNetworkNativePort({
    request: async () => ({ body, headers: [], status: 200, statusText: 'OK', url: 'https://example.test/' })
  })
  const exchange = openExchange(port, 'reader-cancel-error')
  await finishExchange(port, 'reader-cancel-error', exchange, () => {})
  const callToken = readExchange(port, 'reader-cancel-error', exchange, () => {})
  port.cancel(callToken)
  port.cancel(callToken)
  port.closeResource(exchange.ownerCallToken, exchange.providerToken)
  await settle()
  assert.deepEqual({ cancels, releases }, { cancels: 1, releases: 1 })
})

for (const cancellation of ['finish-token', 'http-cancel']) {
  test(`discards a late streaming response head once after ${cancellation}`, async () => {
    let resolveRequest
    let returns = 0
    let pulls = 0
    let signal
    const body = {
      [Symbol.asyncIterator]() {
        return this
      },
      async next() {
        pulls += 1
        return { done: false, value: Uint8Array.from([1]) }
      },
      async return() {
        returns += 1
        return { done: true, value: undefined }
      }
    }
    const port = new NodeNetworkNativePort({
      request: input => {
        signal = input.signal
        return new Promise(resolve => {
          resolveRequest = resolve
        })
      }
    })
    const exchange = openExchange(port, `late-${cancellation}`)
    const finishEvents = []
    const pending = finishExchange(port, `late-${cancellation}`, exchange, event => finishEvents.push(event))
    if (cancellation === 'finish-token') {
      port.cancel(`finish-call:late-${cancellation}`)
    } else {
      const cancelEvents = []
      port.dispatch(
        {
          args: { response: exchange.response },
          id: `cancel:late-${cancellation}`,
          module: 'host.network',
          operation: 'v1.http.cancel'
        },
        { ...context(`cancel-call:late-${cancellation}`), resources: [exchange.binding] },
        event => cancelEvents.push(event),
        () => {}
      )
      assert.equal(cancelEvents[0].type, 'result')
    }
    assert.equal(signal.aborted, true)
    resolveRequest({ body, headers: [], status: 200, statusText: 'OK', url: 'https://example.test/' })
    await pending
    await settle()
    assert.deepEqual(finishEvents, [])
    assert.deepEqual({ pulls, returns }, { pulls: 0, returns: 1 })
  })
}

test('retains the buffered response path', async () => {
  const port = new NodeNetworkNativePort({
    request: async () => ({
      body: Uint8Array.from([1, 2, 3]),
      headers: [],
      status: 200,
      statusText: 'OK',
      url: 'https://example.test/'
    })
  }, { maxChunkBytes: 2 })
  const exchange = openExchange(port, 'buffered')
  await finishExchange(port, 'buffered', exchange, () => {})
  const events = []
  const callToken = readExchange(port, 'buffered', exchange, event => events.push(event))
  port.grantCredits(callToken, 3)
  assert.deepEqual(events.map(event => event.type), ['chunk', 'chunk', 'end'])
  assert.deepEqual(events.slice(0, 2).map(event => [...event.binary[0].data]), [[1, 2], [3]])
})
