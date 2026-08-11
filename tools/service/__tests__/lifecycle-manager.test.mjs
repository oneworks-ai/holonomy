import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { createAdbPort } from '../adb-port.mjs'
import { createHolonomyServiceLifecycleManager } from '../lifecycle-manager.mjs'
import { createOptionalAndroidRuntimeAdapter } from '../optional-android-target-adapter.mjs'
import { createHolonomyServiceClient } from '../service-client.mjs'
import { serviceHomePaths } from '../service-home.mjs'
import { ensureHolonomyServiceProcess } from '../service-process.mjs'
import { createTargetAdapterDispatcher } from '../target-adapters.mjs'
import { runtimeLaunch } from './sandbox-fixture.mjs'

describe('service singleton lifecycle', () => {
  it('separates owner-private endpoint token state and journal and supports reuse rotation and stop', async () => {
    const home = await mkdtemp(join(tmpdir(), 'holonomy-service-home-'))
    const paths = serviceHomePaths(home)
    const manager = createHolonomyServiceLifecycleManager({ home, service: { port: 0 } })
    try {
      const started = await manager.ensure()
      assert.equal(started.running, true)
      assert.equal(started.reused, false)
      assert.equal((await manager.ensure()).reused, true)
      const firstToken = await readFile(paths.token, 'utf8')
      await manager.rotateToken()
      const secondToken = await readFile(paths.token, 'utf8')
      assert.notEqual(firstToken, secondToken)
      for (const path of [home, paths.journal, paths.state]) {
        assert.equal((await stat(path)).mode & 0o777, 0o700)
      }
      for (const path of [paths.endpoint, paths.lock, paths.token]) {
        assert.equal((await stat(path)).mode & 0o777, 0o600)
      }
      assert.deepEqual(await manager.stop(), { stopped: true })
      await assert.rejects(stat(paths.endpoint), error => error.code === 'ENOENT')
      await assert.rejects(stat(paths.lock), error => error.code === 'ENOENT')
    } finally {
      await manager.stop({ drain: true }).catch(() => undefined)
      await rm(home, { force: true, recursive: true })
    }
  })

  it('spawns a detached machine service and waits for its health without hosting it in the caller', async () => {
    const home = await mkdtemp(join(tmpdir(), 'holonomy-service-process-'))
    let polls = 0
    let spawnOptions
    let unrefCalls = 0
    try {
      const result = await ensureHolonomyServiceProcess({
        client: {
          status: async () =>
            polls++ === 0 ? { running: false } : {
              endpoint: { baseUrl: 'http://127.0.0.1:43210' },
              running: true
            }
        },
        environment: {},
        home,
        spawn: (_file, _args, options) => {
          spawnOptions = options
          return { unref: () => unrefCalls += 1 }
        }
      })
      assert.equal(result.reused, false)
      assert.equal(spawnOptions.detached, true)
      assert.equal(spawnOptions.env.HOLONOMY_HOME, home)
      assert.equal(unrefCalls, 1)
    } finally {
      await rm(home, { force: true, recursive: true })
    }
  })

  it('rejects non-draining shutdown before acknowledging active owned resources', async () => {
    const home = await mkdtemp(join(tmpdir(), 'holonomy-service-drain-'))
    const android = createAdbPort({
      listDevices: async () => [{
        id: 'android:device-1',
        kind: 'physical',
        platform: 'android',
        serial: 'device-1',
        state: 'online'
      }],
      listEmulators: async () => [],
      startProcess: async () => ({}),
      stopProcess: async () => undefined,
      subscribeProcess: () => () => undefined
    })
    const manager = createHolonomyServiceLifecycleManager({
      adapterDispatcher: createTargetAdapterDispatcher({ android }),
      home,
      service: { port: 0 }
    })
    try {
      await manager.ensure()
      const client = createHolonomyServiceClient({ home })
      await client.call('/v1/devices:refresh', { method: 'POST' })
      const admitted = await client.launchProcess({
        deviceId: 'android:device-1',
        entryUrl: 'app+local://workspace/main.mjs',
        inspectorMode: 'off',
        isolation: 'runtime',
        launch: runtimeLaunch('android'),
        target: 'android'
      }, 'active-shutdown-process')
      for (let turn = 0; turn < 500; turn += 1) {
        const operation = await client.getOperation(admitted.value.operation.id)
        if (operation.state === 'succeeded') break
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      await assert.rejects(
        manager.requestShutdown({ drain: false }),
        error => error.code === 'service.conflict'
      )
      assert.equal((await manager.status()).running, true)
    } finally {
      await manager.stop({ drain: true }).catch(() => undefined)
      await rm(home, { force: true, recursive: true })
    }
  })

  it('fails shutdown closed on inventory and drain cleanup failures', async () => {
    const home = await mkdtemp(join(tmpdir(), 'holonomy-service-fail-closed-'))
    let inventoryFailure = true
    let cleanupFailure = false
    let emulators = []
    const core = {
      closeInspector: async () => undefined,
      get: () => ({ state: 'succeeded' }),
      listEmulators: async () => {
        if (inventoryFailure) throw new Error('inventory unavailable')
        return emulators
      },
      snapshot: () => ({ resources: { inspectors: {}, processes: {} } }),
      stopEmulator: async () => {
        if (cleanupFailure) throw new Error('cleanup failed')
        emulators = []
      }
    }
    const service = {
      close: async () => undefined,
      core,
      rotateToken() {},
      start: async () => 'http://127.0.0.1:43210'
    }
    const manager = createHolonomyServiceLifecycleManager({
      client: { status: async () => ({ running: false }) },
      createService: () => service,
      home
    })
    try {
      await manager.ensure()
      await assert.rejects(
        manager.requestShutdown({ drain: false }),
        error => error.code === 'service.unavailable'
      )
      inventoryFailure = false
      cleanupFailure = true
      emulators = [{ id: 'managed-avd', managed: true, ownerNonce: 'owner', state: 'running' }]
      await assert.rejects(manager.requestShutdown({ drain: true }), /cleanup failed/u)
    } finally {
      cleanupFailure = false
      emulators = []
      await manager.stop({ drain: true }).catch(() => undefined)
      await rm(home, { force: true, recursive: true })
    }
  })

  it('fails shutdown closed for persisted managed emulators when the SDK is unavailable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'holonomy-service-persisted-emulator-'))
    const emulatorStateFile = join(home, 'emulators.json')
    await writeFile(
      emulatorStateFile,
      JSON.stringify({
        owners: [{
          id: 'managed-avd',
          launcherPid: 31_337,
          ownerNonce: 'persisted-owner',
          serial: 'emulator-5554'
        }],
        version: 1
      })
    )
    const android = createOptionalAndroidRuntimeAdapter({
      createAdapter: () => {
        throw new Error('Android SDK unavailable')
      },
      emulatorStateFile
    })
    const service = {
      close: async () => android.close(),
      core: {
        closeInspector: async () => undefined,
        listEmulators: async () => await android.listEmulators({}),
        snapshot: () => ({ resources: { inspectors: {}, processes: {} } }),
        stopEmulator: async id => await android.stopEmulator({ id })
      },
      rotateToken() {},
      start: async () => 'http://127.0.0.1:43210'
    }
    const manager = createHolonomyServiceLifecycleManager({
      client: { status: async () => ({ running: false }) },
      createService: () => service,
      home
    })
    try {
      await manager.ensure()
      assert.deepEqual(await android.listEmulators({}), [{
        id: 'managed-avd',
        managed: true,
        ownerNonce: 'persisted-owner',
        serial: 'emulator-5554',
        state: 'running',
        verified: false
      }])
      await assert.rejects(manager.requestShutdown({ drain: false }), error => error.code === 'service.conflict')
      await assert.rejects(manager.requestShutdown({ drain: true }), error => error.code === 'service.unsupported')
    } finally {
      await writeFile(emulatorStateFile, JSON.stringify({ owners: [], version: 1 }))
      await manager.stop({ drain: true }).catch(() => undefined)
      await rm(home, { force: true, recursive: true })
    }
  })
})
