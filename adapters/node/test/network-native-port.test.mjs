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
