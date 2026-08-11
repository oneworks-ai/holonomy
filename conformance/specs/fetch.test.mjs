import assert from 'node:assert/strict'
import process from 'node:process'
import { describe, it } from 'node:test'

describe('Fetch', () => {
  it('installs the Web fetch surface', () => {
    assert.equal(typeof fetch, 'function')
    assert.equal(typeof Headers, 'function')
    assert.equal(typeof Request, 'function')
    assert.equal(typeof Response, 'function')
    assert.equal(typeof AbortController, 'function')
  })

  it('reads JSON through the host network provider', async () => {
    assert.equal(typeof fetch, 'function')
    const baseUrl = process.env.HOLONOMY_FIXTURE_URL
    assert.ok(baseUrl, 'HOLONOMY_FIXTURE_URL must be injected by the CLI')
    const response = await fetch(`${baseUrl}/profile`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { runtime: 'holonomy' })
  })

  it('cancels an active request', async () => {
    assert.equal(typeof fetch, 'function')
    const controller = new AbortController()
    const request = fetch(`${process.env.HOLONOMY_FIXTURE_URL}/slow`, { signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(request)
  })
})
