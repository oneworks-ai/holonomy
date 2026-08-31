import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { canonicalizeNetworkResource } from 'holonomy/capability-runtime'
import { NodeNetworkAuthorizationProviderV1 } from '../src/capability-network-provider.mjs'

const context = resource => ({
  member: 'fetch',
  operation: 'network.fetch.request',
  requestId: 'network-resolution-test',
  resource: { requested: resource },
  runtime: { generation: 7 }
})

const authority = allowPrivateNetwork => ({
  bindings: [{
    constraints: {
      allowPrivateNetwork,
      mode: 'restricted',
      origins: ['https://example.test'],
      schemes: ['https']
    },
    providerModule: 'host.network'
  }]
})

test('freezes Broker-admitted DNS evidence and binds it to the exact response resource', async () => {
  let resolveCalls = 0
  const provider = new NodeNetworkAuthorizationProviderV1('host.network', 7, async () => {
    resolveCalls += 1
    return [
      { address: '2001:4860:4860::8888', family: 6 },
      { address: '93.184.216.34', family: 4 }
    ]
  })
  const resource = canonicalizeNetworkResource('https://example.test/path', 'GET', null, 'test')
  const invocation = context(resource)
  const plan = await provider.preflight(invocation, authority(false))

  assert.equal(resolveCalls, 1)
  assert.deepEqual(plan.requests[0].evidence.addresses, ['2001:4860:4860::8888', '93.184.216.34'])
  const terminal = plan.execute(
    { ...invocation, resource: { requested: resource, resolved: resource } },
    [{ complete: (result, resources) => ({ resources, result }) }]
  )
  const bindingId = terminal.result.value.binding.bindingId
  assert.deepEqual(provider.resolution(bindingId, 'https://example.test/other'), plan.requests[0].evidence.addresses)
  assert.throws(() => provider.resolution(bindingId, 'https://other.test/path'), { code: 'dns_rebind' })
  const clone = provider.invoke(
    {
      member: 'Response.clone',
      operation: 'network.response.body.read',
      requestId: 'network-clone-test',
      resource: { inheritedBindingId: bindingId, requested: resource },
      runtime: { generation: 7 }
    },
    {
      ...authority(false),
      complete: (result, resources) => ({ resources, result })
    }
  )
  const cloneBindingId = clone.result.value.binding.bindingId
  assert.notEqual(cloneBindingId, bindingId)
  assert.deepEqual(
    provider.resolution(cloneBindingId, 'https://example.test/clone'),
    plan.requests[0].evidence.addresses
  )
  terminal.resources[0].close()
  assert.throws(() => provider.resolution(bindingId, 'https://example.test/path'), { code: 'dns_rebind' })
  assert.deepEqual(
    provider.resolution(cloneBindingId, 'https://example.test/clone'),
    plan.requests[0].evidence.addresses
  )
  clone.resources[0].close()
  assert.throws(() => provider.resolution(cloneBindingId, 'https://example.test/clone'), { code: 'dns_rebind' })
})

test('rejects a mixed private DNS set before publishing a transport binding', async () => {
  const provider = new NodeNetworkAuthorizationProviderV1('host.network', 7, async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 }
  ])
  const resource = canonicalizeNetworkResource('https://example.test/path', 'GET', null, 'test')
  await assert.rejects(provider.preflight(context(resource), authority(false)), { code: 'policy.denied' })
})
