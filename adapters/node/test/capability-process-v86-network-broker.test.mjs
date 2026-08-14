import assert from 'node:assert/strict'
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
    return Promise.resolve({
      authorized: true,
      generation: 9,
      invocationBindingDigest: `${invoked.length}`.repeat(64),
      semanticResourceDigest: 'a'.repeat(64)
    })
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
  const broker = new NodeV86ProcessNetworkBrokerV1({ fetch: globalThis.fetch }).bind(() => {
    throw new Error('must not authorize')
  })
  await assert.rejects(
    broker.fetch({ ...input, url: 'https://api.example/data' }),
    error => error.code === 'process.network_endpoint_unsupported'
  )
})
