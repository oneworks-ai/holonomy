import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Adapter-owned Provider teardown boundary.
import test from 'node:test'

import { closeNodeCapabilityProvidersV1 } from '../src/capability-providers.mjs'

test('Provider teardown starts all synchronous revocations before awaiting a slow close', async () => {
  const events = []
  let finish
  const slow = new Promise(resolve => finish = resolve)
  const providers = new Map([
    ['slow', {
      close: () => {
        events.push('slow')
        return slow
      }
    }],
    ['throw', {
      close: () => {
        events.push('throw')
        throw new Error('close failed')
      }
    }],
    ['reject', {
      close: () => {
        events.push('reject')
        return Promise.reject(new Error('rejected'))
      }
    }],
    ['last', { close: () => events.push('last') }],
    ['no-close', {}]
  ])
  const closing = closeNodeCapabilityProvidersV1(providers)
  assert.deepEqual(events, ['slow', 'throw', 'reject', 'last'])
  finish()
  const results = await closing
  assert.equal(results.length, providers.size)
  assert.equal(results[2].status, 'rejected')
})
