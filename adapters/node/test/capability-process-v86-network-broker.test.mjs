import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { NodeV86ProcessNetworkBrokerV1 } from '../src/capability-process-v86-network-broker.mjs'

const policy = {
  access: 'sandboxed',
  network: {
    access: 'restricted',
    endpoints: [
      { hostname: '127.0.0.1', ports: [8123], transport: 'tcp' },
      { hostname: '127.0.0.2', ports: [8443], transport: 'tls' }
    ],
    maxSockets: 2
  }
}
const input = {
  environmentId: '9:processTree:process-1',
  executableId: 'curl',
  generation: 9,
  init: { method: 'GET' },
  linuxPid: 41,
  policy,
  processId: 37,
  processResourceId: 'process-1',
  scope: 'processTree',
  signal: new AbortController().signal,
  url: 'http://127.0.0.1:8123/start'
}
const receipt = address => ({
  authorized: true,
  generation: 9,
  invocationBindingDigest: 'd'.repeat(64),
  resolution: {
    addresses: [address],
    evidenceDigest: 'f'.repeat(64),
    expiresAtMonotonicMs: Number.MAX_SAFE_INTEGER,
    resolverGeneration: 9
  },
  semanticResourceDigest: 'e'.repeat(64)
})

test('authorizes every exact-IP v86 HTTP redirect with process attribution', async () => {
  const invoked = []
  const fetched = []
  const broker = new NodeV86ProcessNetworkBrokerV1({
    fetch(url, init) {
      fetched.push([String(url), init])
      return Promise.resolve(
        fetched.length === 1
          ? new Response(null, { headers: { location: 'https://127.0.0.2:8443/final' }, status: 302 })
          : new Response('done', { status: 200 })
      )
    }
  }).bind(request => {
    invoked.push(request)
    return Promise.resolve(receipt(request.arguments.hostname))
  })

  const response = await broker.fetch(input)
  assert.equal(await response.text(), 'done')
  assert.deepEqual(invoked.map(item => item.arguments), [
    { hostname: '127.0.0.1', port: 8123, transport: 'tcp' },
    { hostname: '127.0.0.2', port: 8443, transport: 'tls' }
  ])
  assert.equal(invoked[0].source.linuxPid, 41)
  assert.deepEqual(fetched.map(item => item[0]), [
    'http://127.0.0.1:8123/start',
    'https://127.0.0.2:8443/final'
  ])
})

test('rejects DNS endpoints until a resolved-address evidence owner is installed', async () => {
  let invoked = false
  const broker = new NodeV86ProcessNetworkBrokerV1({ fetch: globalThis.fetch }).bind(() => {
    invoked = true
    throw new Error('must not authorize')
  })
  await assert.rejects(
    broker.fetch({ ...input, url: 'https://api.example/data' }),
    error => error.code === 'process.network_endpoint_unsupported'
  )
  assert.equal(invoked, false)
})

test('enforces maxSockets across concurrent HTTP response bodies', async () => {
  const limited = structuredClone(policy)
  limited.network.maxSockets = 1
  const broker = new NodeV86ProcessNetworkBrokerV1({
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('open'))
          }
        }),
        { status: 200 }
      )
  }).bind(async request => receipt(request.arguments.hostname))

  const first = await broker.fetch({ ...input, policy: limited })
  await assert.rejects(broker.fetch({ ...input, policy: limited }), { code: 'provider.quota' })

  await first.body.cancel()
  const afterRelease = await broker.fetch({ ...input, policy: limited })
  await afterRelease.body.cancel()
})

test('connects a DNS socket only to the address admitted by the Process Provider', async () => {
  const dnsPolicy = structuredClone(policy)
  dnsPolicy.network.endpoints = [{ hostname: 'example.test', ports: [8123], transport: 'tcp' }]
  let connected
  let connectCalls = 0
  const createConnection = options => {
    connectCalls += 1
    connected = options
    const socket = new EventEmitter()
    socket.destroy = () => queueMicrotask(() => socket.emit('close'))
    queueMicrotask(() => socket.emit('connect'))
    return socket
  }
  const broker = new NodeV86ProcessNetworkBrokerV1({
    createConnection
  }).bind(async () => receipt('93.184.216.34'))
  const socket = await broker.connect({
    ...input,
    hostname: 'example.test',
    policy: dnsPolicy,
    port: 8123
  })
  assert.equal(connected.host, '93.184.216.34')
  socket.destroy()
  await new Promise(resolve => setImmediate(resolve))

  const expiredBroker = new NodeV86ProcessNetworkBrokerV1({ createConnection }).bind(async () => ({
    ...receipt('93.184.216.34'),
    resolution: { ...receipt('93.184.216.34').resolution, expiresAtMonotonicMs: 0 }
  }))
  await assert.rejects(
    expiredBroker.connect({
      ...input,
      hostname: 'example.test',
      policy: dnsPolicy,
      port: 8123
    }),
    { code: 'resource.stale' }
  )
  assert.equal(connectCalls, 1)
})
