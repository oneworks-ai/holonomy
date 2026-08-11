import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
// eslint-disable-next-line test/no-import-node-test -- This adapter is verified with Node's public test runner.
import test from 'node:test'

import { NodeNetworkAuthority, isPrivateAddress } from '../src/network-authority.mjs'
import { NodeHttpNetworkHost } from '../src/node-http-network-host.mjs'

const createTransport = (capture, responseOptions = {}) => options => {
  capture.options = options
  const outbound = new EventEmitter()
  outbound.destroy = error => queueMicrotask(() => outbound.emit('error', error))
  outbound.end = () =>
    queueMicrotask(() => {
      const response = new EventEmitter()
      response.destroy = error => queueMicrotask(() => response.emit('error', error))
      response.rawHeaders = responseOptions.rawHeaders ?? ['content-type', 'text/plain']
      response.statusCode = responseOptions.status ?? 302
      capture.callback(response)
      response.emit('data', Uint8Array.from([111, 107]))
      response.emit('end')
    })
  outbound.setTimeout = () => {}
  outbound.write = body => {
    capture.body = Uint8Array.from(body)
  }
  return outbound
}

const createHost = ({ address = '93.184.216.34', rules, response, secure = true } = {}) => {
  const capture = {}
  const transport = (options, callback) => {
    capture.callback = callback
    return createTransport(capture, response)(options)
  }
  const authority = new NodeNetworkAuthority(rules ?? [{ origin: 'https://example.test:8443' }])
  const host = new NodeHttpNetworkHost({
    authority,
    checkServerIdentity: (hostname, certificate) => {
      capture.certificate = certificate
      capture.verifiedHostname = hostname
    },
    httpRequest: secure ? undefined : transport,
    httpsRequest: secure ? transport : undefined,
    resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }]
  })
  return { capture, host }
}

test('pins the authorized address while preserving hostname TLS verification', async () => {
  const { capture, host } = createHost()
  const result = await host.request({
    body: Uint8Array.from([1, 2]),
    headers: [['x-test', 'yes']],
    method: 'POST',
    url: 'https://example.test:8443/path?q=1'
  })

  assert.equal(capture.options.agent, false)
  assert.equal(capture.options.servername, 'example.test')
  assert.equal(capture.options.headers.connection, 'close')
  assert.equal(capture.options.path, '/path?q=1')
  assert.deepEqual(capture.body, Uint8Array.from([1, 2]))
  assert.deepEqual(
    await new Promise((resolve, reject) =>
      capture.options.lookup(
        'example.test',
        {},
        (error, address, family) => error == null ? resolve({ address, family }) : reject(error)
      )
    ),
    {
      address: '93.184.216.34',
      family: 4
    }
  )
  const certificate = {}
  capture.options.checkServerIdentity('93.184.216.34', certificate)
  assert.equal(capture.verifiedHostname, 'example.test')
  assert.equal(capture.certificate, certificate)
  assert.equal(result.status, 302)
  assert.equal(new TextDecoder().decode(result.body), 'ok')
})

test('rejects a denied DNS address before opening a request', async () => {
  const { host } = createHost({ address: '127.0.0.1', rules: [{ origin: 'https://example.test' }] })
  await assert.rejects(() => host.request({ url: 'https://example.test/' }), { code: 'permission_denied' })
})

test('classifies mapped IPv6 loopback as private', () => {
  assert.equal(isPrivateAddress('::ffff:7f00:1'), true)
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true)
  assert.equal(isPrivateAddress('2606:2800:220:1:248:1893:25c8:1946'), false)
})

test('returns redirects without following them and emits bounded diagnostics', async () => {
  const events = []
  const capture = {}
  const transport = (options, callback) => {
    capture.callback = callback
    return createTransport(capture, { status: 302 })(options)
  }
  const host = new NodeHttpNetworkHost({
    authority: new NodeNetworkAuthority([{ origin: 'http://example.test' }]),
    httpRequest: transport,
    observer: event => events.push(event),
    resolve: async () => [{ address: '93.184.216.34', family: 4 }]
  })

  const response = await host.request({ url: 'http://example.test/redirect' })

  assert.equal(response.status, 302)
  assert.deepEqual(events.map(event => event.kind), ['request', 'dispatch', 'response'])
  assert.equal(events[0].url, 'http://example.test/redirect')
})

test('rejects mixed DNS authorization and resolver failures before transport', async () => {
  let opened = 0
  const authority = new NodeNetworkAuthority([{ origin: 'https://example.test' }])
  const mixed = new NodeHttpNetworkHost({
    authority,
    httpsRequest: () => {
      opened += 1
    },
    resolve: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 }
    ]
  })
  await assert.rejects(() => mixed.request({ url: 'https://example.test/' }), { code: 'permission_denied' })
  assert.equal(opened, 0)

  const failed = new NodeHttpNetworkHost({
    authority,
    httpsRequest: () => {
      opened += 1
    },
    resolve: async () => {
      throw new Error('platform detail')
    }
  })
  await assert.rejects(() => failed.request({ url: 'https://example.test/' }), { code: 'dns_failed' })
  assert.equal(opened, 0)
})
