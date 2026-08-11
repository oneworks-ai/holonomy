import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { startHolonomyNetworkFixture } from '../../holonomy-network-fixture.mjs'
import { ConformanceFixtureManager, withFixtureUrl } from '../fixture-manager.mjs'
import { createHolonomyServiceClient } from '../service-client.mjs'
import { ensureHolonomyServiceProcess } from '../service-process.mjs'

describe('service client and conformance fixture', () => {
  it('injects only one service-owned fixture URL into the immutable launch', async () => {
    const manager = new ConformanceFixtureManager()
    const process = {
      fixture: { kind: 'conformance-network-v1' },
      generation: 3,
      id: 'process_fixture',
      launch: {},
      target: 'node'
    }
    try {
      const lease = await manager.start(process)
      const response = await fetch(`${lease.baseUrl}/profile`)
      assert.deepEqual(await response.json(), { runtime: 'holonomy' })
      const launch = withFixtureUrl(process, lease.baseUrl)
      assert.equal(launch.launch.env.HOLONOMY_FIXTURE_URL, lease.baseUrl)
      assert.equal(launch.launch.networkAuthority, undefined)
    } finally {
      await manager.close()
    }
  })

  it('rebinds a persisted process fixture exactly after manager recovery and fails closed on takeover', async () => {
    const process = {
      fixture: { kind: 'conformance-network-v1' },
      generation: 1,
      id: 'process_recovered_fixture',
      launch: {},
      target: 'node'
    }
    const firstManager = new ConformanceFixtureManager()
    const first = await firstManager.start(process)
    await firstManager.close()

    const recoveredManager = new ConformanceFixtureManager()
    const recovered = await recoveredManager.start({
      ...process,
      fixtureRuntimeUrl: first.baseUrl,
      generation: 2
    })
    assert.equal(recovered.baseUrl, first.baseUrl)
    assert.deepEqual(await (await fetch(`${recovered.baseUrl}/profile`)).json(), { runtime: 'holonomy' })
    await recoveredManager.close()

    const occupied = await startHolonomyNetworkFixture({ port: Number(new URL(first.baseUrl).port) })
    try {
      const blockedManager = new ConformanceFixtureManager()
      await assert.rejects(
        blockedManager.start({ ...process, fixtureRuntimeUrl: first.baseUrl, generation: 3 }),
        error => error.code === 'EADDRINUSE'
      )
      await blockedManager.close()
    } finally {
      await occupied.close()
    }
  })

  it('rejects unsafe persisted fixture origins and bounds retained process leases', async () => {
    const manager = new ConformanceFixtureManager({ maxLeases: 1 })
    const descriptor = { kind: 'conformance-network-v1' }
    try {
      await assert.rejects(
        manager.start({
          fixture: descriptor,
          fixtureRuntimeUrl: 'http://localhost:48125',
          generation: 1,
          id: 'process_unsafe_fixture'
        }),
        error => error.code === 'service.state_corrupt'
      )
      await manager.start({ fixture: descriptor, generation: 1, id: 'process_fixture_one' })
      await assert.rejects(
        manager.start({ fixture: descriptor, generation: 1, id: 'process_fixture_two' }),
        error => error.code === 'service.limit_exceeded'
      )
    } finally {
      await manager.close()
    }
  })

  it('uses explicit remote URL and token file without local endpoint fallback or auto-start', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-remote-client-'))
    const tokenFile = join(directory, 'remote.token')
    const calls = []
    await writeFile(tokenFile, 'remote-token-that-is-at-least-thirty-two-bytes\n', { mode: 0o600 })
    try {
      const client = createHolonomyServiceClient({
        environment: {
          HOLONOMY_OPENAPI_TOKEN_FILE: tokenFile,
          HOLONOMY_OPENAPI_URL: 'https://runtime.example.test/openapi.json'
        },
        request: async (baseUrl, path, options) => {
          calls.push({ baseUrl, options, path })
          return path === '/healthz' ? { status: 'ready' } : { ok: true }
        }
      })
      assert.equal((await client.status()).running, true)
      assert.deepEqual(await client.call('/v1/devices'), { ok: true })
      assert.equal(calls[1].baseUrl, 'https://runtime.example.test')
      assert.equal(calls[1].options.token, 'remote-token-that-is-at-least-thirty-two-bytes')
      await client.getProcess('process/1')
      await client.getOperation('operation/1')
      await client.closeInspector('process/1', 'inspector/1', 2, 'close-inspector')
      await client.emulatorAction('pixel/1', 'restart', { coldBoot: true })
      assert.deepEqual(calls.slice(2).map(call => [call.path, call.options.method]), [
        ['/v1/processes/process%2F1', undefined],
        ['/v1/operations/operation%2F1', undefined],
        ['/v1/processes/process%2F1/inspector-leases/inspector%2F1', 'DELETE'],
        ['/v1/emulators/pixel%2F1:restart', 'POST']
      ])

      await chmod(tokenFile, 0o644)
      await assert.rejects(
        client.call('/v1/devices'),
        error => error.code === 'service.state_corrupt'
      )

      const linkedToken = join(directory, 'linked.token')
      await chmod(tokenFile, 0o600)
      await symlink(tokenFile, linkedToken)
      const linkedClient = createHolonomyServiceClient({
        baseUrl: 'https://runtime.example.test',
        request: async () => ({ ok: true }),
        tokenFile: linkedToken
      })
      await assert.rejects(
        linkedClient.call('/v1/devices'),
        error => error.code === 'service.state_corrupt'
      )

      const oversizedToken = join(directory, 'oversized.token')
      await writeFile(oversizedToken, 'a'.repeat(4097), { mode: 0o600 })
      const oversizedClient = createHolonomyServiceClient({
        baseUrl: 'https://runtime.example.test',
        request: async () => ({ ok: true }),
        tokenFile: oversizedToken
      })
      await assert.rejects(
        oversizedClient.call('/v1/devices'),
        error => error.code === 'service.state_corrupt'
      )

      let spawned = false
      await assert.rejects(
        ensureHolonomyServiceProcess({
          client: { status: async () => ({ running: false }) },
          environment: { HOLONOMY_OPENAPI_URL: 'https://runtime.example.test/openapi.json' },
          spawn: () => {
            spawned = true
          }
        }),
        error => error.code === 'service.unavailable'
      )
      assert.equal(spawned, false)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('rejects cleartext non-loopback remote endpoints', () => {
    assert.throws(
      () => createHolonomyServiceClient({ baseUrl: 'http://runtime.example.test' }),
      error => error.code === 'service.invalid_request'
    )
  })
})
