import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runWithHolonomyNetworkFixture } from '../../tools/holonomy-network-fixture.mjs'

describe('holonomy CLI network fixture', () => {
  it('injects a loopback profile endpoint and closes it after the session', async () => {
    let fixtureUrl = ''
    await runWithHolonomyNetworkFixture({
      command: 'test',
      entries: [resolve('conformance/specs/fetch.test.mjs')],
      env: { HOLONOMY_FIXTURE_URL: 'http://untrusted.invalid' }
    }, async fixture => {
      fixtureUrl = fixture.env.HOLONOMY_FIXTURE_URL
      expect(fixtureUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
      expect(fixture.networkFixturePort).toBe(Number(new URL(fixtureUrl).port))
      const response = await fetch(`${fixtureUrl}/profile`)
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ runtime: 'holonomy' })
    })

    await expect(fetch(`${fixtureUrl}/profile`)).rejects.toThrow()
  })

  it('allows an active slow request to be cancelled', async () => {
    await runWithHolonomyNetworkFixture({
      command: 'test',
      entries: [resolve('conformance/specs/fetch.test.mjs')],
      env: {}
    }, async fixture => {
      const controller = new AbortController()
      const request = fetch(`${fixture.env.HOLONOMY_FIXTURE_URL}/slow`, { signal: controller.signal })
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
      controller.abort()
      await expect(request).rejects.toThrow()
    })
  })

  it('does not start or inject a fixture for unrelated tests', async () => {
    const env = { EXISTING: 'value' }
    await expect(runWithHolonomyNetworkFixture({
      command: 'test',
      entries: [resolve('conformance/specs/timers.test.mjs')],
      env
    }, fixture => {
      expect(fixture.env).toBe(env)
      expect(fixture.networkFixturePort).toBeUndefined()
      return 'unchanged'
    })).resolves.toBe('unchanged')
  })
})
