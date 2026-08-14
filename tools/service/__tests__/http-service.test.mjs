import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { createAdbPort } from '../adb-port.mjs'
import { admitRequestHost, validateHttpConfiguration } from '../http-utils.mjs'
import { createHolonomyService } from '../server.mjs'
import { restrictedSandboxPolicy, runtimeLaunch } from './sandbox-fixture.mjs'

const token = 'test-token-that-is-at-least-thirty-two-bytes'

const request = async (baseUrl, path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, options)
  return { body: await response.json(), status: response.status }
}

const waitForSucceededOperation = async (core, operationId, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const operation = core.get('operations', operationId, 'Operation')
    if (operation.state === 'succeeded') return operation
    assert.ok(
      operation.state === 'queued' || operation.state === 'running',
      `Operation ${operationId} reached ${operation.state}: ${JSON.stringify(operation.error)}`
    )
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`Operation ${operationId} did not succeed within ${timeoutMs}ms`)
}

const openWebSocket = async (url, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = new WebSocket(url)
        let settled = false
        let timer
        const succeed = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(socket)
        }
        const fail = error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try {
            socket.close()
          } catch {
            // A failed CONNECTING socket may already be closed by the implementation.
          }
          reject(error)
        }
        timer = setTimeout(
          () => fail(new Error('WebSocket handshake timed out')),
          Math.min(500, Math.max(1, deadline - Date.now()))
        )
        socket.addEventListener('open', succeed, { once: true })
        socket.addEventListener('error', event => fail(event.error ?? new Error('WebSocket handshake failed')), {
          once: true
        })
      })
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  assert.fail(`WebSocket did not open within ${timeoutMs}ms: ${lastError?.message ?? 'unknown error'}`)
}

const withService = async callback => {
  const directory = await mkdtemp(join(tmpdir(), 'holonomy-http-service-'))
  const evidence = { emulatorStarts: 0 }
  const service = createHolonomyService({
    adbPort: createAdbPort({
      listDevices: async () => [{ id: 'android:device-1', kind: 'physical', serial: 'device-1', state: 'online' }],
      openInspector: async () => ({
        targetSession: 1,
        transport: {
          close() {},
          send: async message => ({ id: message.id, result: { upstream: true } })
        }
      }),
      listEmulators: async () => [{ id: 'pixel', managed: false, state: 'stopped' }],
      exposeFixture: async input => input.baseUrl,
      startEmulator: async () => {
        evidence.emulatorStarts += 1
        return { id: 'pixel', managed: true, ownerNonce: 'owner', state: 'running' }
      },
      startProcess: async () => ({}),
      stopProcess: async () => undefined
    }),
    maxRequestBytes: 2_048,
    port: 0,
    stateDirectory: directory,
    token
  })
  try {
    await service.start()
    return await callback(service, evidence)
  } finally {
    await service.close()
    await rm(directory, { force: true, recursive: true })
  }
}

describe('holonomy loopback service', () => {
  it('publishes OpenAPI while protecting resource operations with a bearer token', async () => {
    await withService(async service => {
      const health = await request(service.baseUrl, '/healthz')
      assert.equal(health.status, 200)
      const specification = await request(service.baseUrl, '/openapi.json')
      assert.equal(specification.body.openapi, '3.1.0')
      assert.ok(specification.body.paths['/v1/processes/{processId}:restart'])

      const denied = await request(service.baseUrl, '/v1/devices')
      assert.equal(denied.status, 401)
      assert.equal(denied.body.error.code, 'service.unauthorized')
      const refreshed = await request(service.baseUrl, '/v1/devices:refresh', {
        headers: { authorization: `Bearer ${token}` },
        method: 'POST'
      })
      assert.equal(refreshed.status, 200)
      assert.equal(refreshed.body[0].id, 'android:device-1')
    })
  })

  it('bounds JSON requests and replays cursor-addressed SSE events', async () => {
    await withService(async service => {
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      const oversized = await request(service.baseUrl, '/v1/service:shutdown', {
        body: JSON.stringify({ drain: false, payload: 'x'.repeat(4_096) }),
        headers: { ...headers, 'idempotency-key': 'oversized' },
        method: 'POST'
      })
      assert.equal(oversized.status, 413)

      await request(service.baseUrl, '/v1/devices:refresh', {
        headers: { authorization: `Bearer ${token}` },
        method: 'POST'
      })
      const processStart = await request(service.baseUrl, '/v1/processes', {
        body: JSON.stringify({
          deviceId: 'android:device-1',
          entryUrl: 'app+local://workspace/main.mjs',
          inspectorMode: 'off',
          isolation: 'runtime',
          launch: runtimeLaunch('android', { source: `/*${'x'.repeat(4_096)}*/ export {}` }),
          target: 'android'
        }),
        headers: { ...headers, 'idempotency-key': 'larger-process-start' },
        method: 'POST'
      })
      assert.equal(processStart.status, 202)
      const response = await fetch(`${service.baseUrl}/v1/events?after=0`, {
        headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` }
      })
      assert.equal(response.status, 200)
      const reader = response.body.getReader()
      let content = ''
      while (!content.includes('devices.refreshed')) {
        const chunk = await reader.read()
        assert.equal(chunk.done, false)
        content += new TextDecoder().decode(chunk.value)
      }
      assert.match(content, /id: \d+/u)
      assert.match(content, /event: devices\.refreshed/u)
      await reader.cancel()
    })
  })

  it('publishes only the pending or effective Process DTO and redacts guest launch internals', async () => {
    await withService(async service => {
      const headers = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'fixture-process'
      }
      const started = await request(service.baseUrl, '/v1/processes', {
        body: JSON.stringify({
          deviceId: 'android:device-1',
          entryUrl: 'app+local://workspace/main.mjs',
          fixture: { kind: 'conformance-network-v1' },
          inspectorMode: 'off',
          isolation: 'runtime',
          launch: runtimeLaunch('android', {
            env: { TOP_SECRET: 'must-not-leak' },
            source: 'export const TOP_SECRET = true'
          }),
          sandboxPolicy: restrictedSandboxPolicy(['http://conformance.invalid'], {
            allowedSchemes: ['http'],
            allowPrivateNetwork: true
          }),
          target: 'android'
        }),
        headers,
        method: 'POST'
      })
      assert.equal(started.status, 202, JSON.stringify(started.body))
      assert.equal(started.body.value.process.sandboxPolicyState, 'pending')
      assert.equal(started.body.value.process.sandboxPolicy, undefined)
      assert.equal(started.body.value.process.sandboxPolicyDigest, undefined)
      assert.equal(started.body.value.process.launch, undefined)
      const processId = started.body.value.process.id
      const operationId = started.body.value.operation.id
      await waitForSucceededOperation(service.core, operationId)
      const operation = (await request(service.baseUrl, `/v1/operations/${operationId}`, { headers })).body
      const current = (await request(service.baseUrl, `/v1/processes/${processId}`, { headers })).body
      assert.equal(current.sandboxPolicyState, 'effective')
      assert.match(current.sandboxPolicyDigest, /^[\da-f]{64}$/u)
      assert.ok(current.sandboxPolicy.network.allowedOrigins.some(origin => origin.startsWith('http://127.0.0.1:')))
      assert.deepEqual(Object.keys(current).sort(), [
        'createdAt',
        'deviceId',
        'entryUrl',
        'generation',
        'id',
        'inspectorMode',
        'isolation',
        'pluginGraphRevision',
        'revision',
        'sandboxPolicy',
        'sandboxPolicyDigest',
        'sandboxPolicyState',
        'sessionId',
        'state',
        'target',
        'updatedAt'
      ])
      assert.deepEqual(operation.result.process, current)
      for (const publicValue of [current, operation.result.process, started.body]) {
        const serialized = JSON.stringify(publicValue)
        assert.doesNotMatch(serialized, /TOP_SECRET|must-not-leak|fixtureRuntimeUrl|sandboxPlan|principal/u)
      }
    })
  })

  it('requires and durably replays idempotency for direct mutations', async () => {
    await withService(async (service, evidence) => {
      const headers = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'emulator-start'
      }
      const first = await request(service.baseUrl, '/v1/emulators/pixel:start', {
        body: JSON.stringify({ coldBoot: true }),
        headers,
        method: 'POST'
      })
      const replay = await request(service.baseUrl, '/v1/emulators/pixel:start', {
        body: JSON.stringify({ coldBoot: true }),
        headers,
        method: 'POST'
      })
      assert.equal(first.status, 200)
      assert.deepEqual(replay.body, first.body)
      assert.equal(evidence.emulatorStarts, 1)
      const drift = await request(service.baseUrl, '/v1/emulators/pixel:start', {
        body: JSON.stringify({ coldBoot: false }),
        headers,
        method: 'POST'
      })
      assert.equal(drift.status, 409)
      const missing = await request(service.baseUrl, '/v1/emulators/pixel:start', {
        body: '{}',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        method: 'POST'
      })
      assert.equal(missing.status, 400)
    })
  })

  it('rejects remote bind and incomplete TLS configuration before listening', () => {
    assert.throws(
      () => createHolonomyService({ host: '0.0.0.0', stateDirectory: '/tmp/unused', token }),
      error => error.code === 'service.invalid_request'
    )
    assert.throws(
      () => createHolonomyService({ stateDirectory: '/tmp/unused', tls: { cert: 'missing-key' }, token }),
      error => error.code === 'service.invalid_request'
    )
    const remote = validateHttpConfiguration({
      advertiseHost: 'runtime.example.test',
      host: '0.0.0.0',
      tls: { cert: 'certificate-bytes', key: 'private-key-bytes' },
      token
    })
    assert.deepEqual(remote.allowedHosts, ['runtime.example.test'])
    assert.doesNotThrow(() =>
      admitRequestHost(
        { headers: { host: 'runtime.example.test:443' } },
        remote.allowedHosts
      )
    )
    assert.throws(
      () => admitRequestHost({ headers: { host: 'attacker.example.test' } }, remote.allowedHosts),
      error => error.code === 'service.invalid_request'
    )
  })

  it('upgrades the process-scoped inspector WebSocket and proxies CDP', async () => {
    await withService(async service => {
      await service.core.refreshDevices()
      const started = await service.core.startProcess({
        deviceId: 'android:device-1',
        entryUrl: 'app+local://workspace/main.mjs',
        inspectorMode: 'enabled',
        isolation: 'runtime',
        launch: {},
        target: 'android'
      }, 'websocket-process')
      await waitForSucceededOperation(service.core, started.value.operation.id)
      const process = service.core.get('processes', started.value.process.id, 'Runtime process')
      const admitted = await service.core.openInspector(process.id, process.generation, {}, 'websocket-inspector')
      await waitForSucceededOperation(service.core, admitted.value.operation.id)
      const inspector = service.core.get('inspectors', admitted.value.inspector.id, 'Inspector lease')
      const socket = await openWebSocket(inspector.webSocketDebuggerUrl)
      const response = new Promise(resolve =>
        socket.addEventListener('message', event => {
          resolve(JSON.parse(String(event.data)))
        }, { once: true })
      )
      socket.send(JSON.stringify({ id: 9, method: 'Runtime.enable' }))
      assert.deepEqual(await response, { id: 9, result: { upstream: true } })
      socket.close()
    })
  }, 15_000)
})
