import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import storage from 'holo:storage'

describe('authorized persistent binary KV', () => {
  it('keeps data across a fresh Runtime generation', async () => {
    const previous = await storage.kv.get('allowed/persist')
    if (globalThis.__storageExpectedExisting) assert.deepEqual(previous, new Uint8Array([0, 255, 7, 0]))
    else assert.equal(previous, null)
    await storage.kv.set('allowed/persist', new Uint8Array([0, 255, 7, 0]))
  })
  it('sets and reads an isolated binary snapshot', async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const pending = storage.kv.set('allowed/copy', bytes)
    bytes[0] = 0
    await pending
    assert.deepEqual(await storage.kv.get('allowed/copy'), new Uint8Array([9, 8, 7]))
  })
  it('lists only matching keys and deletes values', async () => {
    await storage.kv.set('allowed/temp', new Uint8Array(0))
    assert.ok((await storage.kv.list('allowed/')).includes('allowed/temp'))
    assert.equal(await storage.kv.delete('allowed/temp'), true)
    assert.equal(await storage.kv.get('allowed/temp'), null)
    assert.equal(await storage.kv.delete('allowed/temp'), false)
  })
  it('does not widen the namespace prefix through calls or listing', async () => {
    await assert.rejects(storage.kv.get('outside/secret'), { code: 'storage.authorization_denied' })
    await assert.rejects(storage.kv.set('outside/secret', new Uint8Array([1])), {
      code: 'storage.authorization_denied'
    })
    await assert.rejects(storage.kv.list(''), { code: 'storage.authorization_denied' })
  })
  it('cancels before dispatch without creating data', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(storage.kv.set('allowed/cancelled', new Uint8Array([1]), { signal: controller.signal }), {
      code: 'storage.cancelled'
    })
    assert.equal(await storage.kv.get('allowed/cancelled'), null)
  })
})
