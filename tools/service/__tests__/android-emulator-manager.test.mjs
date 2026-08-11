import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { createAndroidEmulatorManager } from '../android-emulator-manager.mjs'
import { readProcessCommand } from '../android-emulator-support.mjs'

const devices = active => (
  `List of devices attached\n${[...active.values()].map(serial => `${serial}\tdevice`).join('\n')}\n`
)

describe('managed Android emulator ownership', () => {
  it('does not invoke a platform process reader where no safe implementation is defined', async () => {
    let reads = 0
    const result = await readProcessCommand(
      async () => {
        reads += 1
        return 'unexpected'
      },
      42,
      undefined,
      'win32'
    )
    assert.equal(result, undefined)
    assert.equal(reads, 0)
  })

  it('uses its durable launcher proof when the emulator does not expose the qemu property', async () => {
    const active = new Map([['external-avd', 'emulator-5556']])
    const invocations = []
    const processCommands = new Map()
    let nextPid = 40_000
    const manager = createAndroidEmulatorManager({
      adb: '/fake/adb',
      emulator: '/bin/echo',
      emulatorTimeoutMs: 100,
      isProcessAlive: pid => processCommands.has(pid),
      pollIntervalMs: 1,
      readProcessCommand: async pid => processCommands.get(pid),
      run: async (file, args) => {
        invocations.push({ args, file })
        if (file === '/bin/echo') return 'managed-avd\nexternal-avd\n'
        if (args[0] === 'devices') return devices(active)
        if (args.includes('name')) {
          const entry = [...active.entries()].find(([, serial]) => serial === args[1])
          return `${entry?.[0] ?? ''}\nOK\n`
        }
        if (args.includes('getprop')) return '\n'
        if (args.includes('kill')) {
          const entry = [...active.entries()].find(([, serial]) => serial === args[1])
          if (entry != null) active.delete(entry[0])
          return 'OK\n'
        }
        return ''
      },
      spawn: (file, args) => {
        invocations.push({ args, file })
        active.set(args[1], 'emulator-5554')
        const pid = nextPid++
        processCommands.set(pid, `/fake/qemu-system-aarch64 ${args.join(' ')}`)
        return {
          kill() {
            processCommands.delete(pid)
          },
          pid,
          unref() {}
        }
      }
    })
    const started = await manager.startEmulator({
      id: 'managed-avd',
      options: { coldBoot: true, wipeData: true }
    })
    assert.equal(started.managed, true)
    assert.match(started.ownerNonce, /^[\da-f]{32}$/u)
    assert.equal((await manager.listEmulators()).find(value => value.id === 'managed-avd')?.managed, true)
    await assert.rejects(
      manager.stopEmulator({ id: 'external-avd' }),
      error => error.code === 'service.conflict'
    )
    const restarted = await manager.restartEmulator({ id: 'managed-avd', options: {} })
    assert.notEqual(restarted.ownerNonce, started.ownerNonce)
    assert.ok(invocations.some(call => call.args.includes('-no-snapshot-load') && call.args.includes('-wipe-data')))
    await manager.close()
    assert.equal(active.has('managed-avd'), false)
    assert.equal(active.has('external-avd'), true)
  })

  it('recovers only an exact persisted launcher and keeps unverifiable ownership for retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-emulator-owner-'))
    const active = new Map()
    const deviceNonces = new Map()
    const processCommands = new Map()
    const run = async (file, args) => {
      if (file === '/bin/echo') return 'managed-avd\n'
      if (args[0] === 'devices') return devices(active)
      if (args.includes('name')) return 'managed-avd\nOK\n'
      if (args.includes('getprop')) return `${deviceNonces.get(args[1]) ?? ''}\n`
      if (args.includes('kill')) {
        active.clear()
        deviceNonces.clear()
        return 'OK\n'
      }
      return ''
    }
    const options = {
      adb: '/fake/adb',
      emulator: '/bin/echo',
      emulatorTimeoutMs: 100,
      isProcessAlive: pid => processCommands.has(pid),
      pollIntervalMs: 1,
      readProcessCommand: async pid => processCommands.get(pid),
      run,
      stateFile: join(directory, 'owners.json')
    }
    const spawn = (_file, args) => {
      active.set(args[1], 'emulator-5554')
      processCommands.set(31_337, `/fake/qemu-system-aarch64 ${args.join(' ')}`)
      return { pid: 31_337, unref() {} }
    }
    try {
      const first = createAndroidEmulatorManager({ ...options, spawn })
      const started = await first.startEmulator({ id: 'managed-avd', options: {} })

      const unavailable = createAndroidEmulatorManager({
        ...options,
        readProcessCommand: async () => {
          throw new Error('process reader is temporarily unavailable')
        }
      })
      assert.equal((await unavailable.listEmulators())[0].managed, false)
      await assert.rejects(
        unavailable.stopEmulator({ id: 'managed-avd' }),
        error => error.code === 'service.conflict'
      )

      const recovered = createAndroidEmulatorManager(options)
      assert.deepEqual(await recovered.listEmulators(), [{
        id: 'managed-avd',
        managed: true,
        ownerNonce: started.ownerNonce,
        serial: 'emulator-5554',
        state: 'running'
      }])
      await recovered.stopEmulator({ id: 'managed-avd' })

      const second = createAndroidEmulatorManager({ ...options, spawn })
      const secondOwner = await second.startEmulator({ id: 'managed-avd', options: {} })
      deviceNonces.set('emulator-5554', 'different-owner')
      const deviceMismatch = createAndroidEmulatorManager(options)
      assert.equal((await deviceMismatch.listEmulators())[0].managed, false)
      await assert.rejects(
        deviceMismatch.stopEmulator({ id: 'managed-avd' }),
        error => error.code === 'service.conflict'
      )
      deviceNonces.clear()
      assert.equal((await createAndroidEmulatorManager(options).listEmulators())[0].managed, true)
      processCommands.set(
        31_337,
        '/fake/qemu-system-aarch64 -avd managed-avd -prop qemu.holonomy.owner_nonce=different-owner'
      )
      const reusedPid = createAndroidEmulatorManager(options)
      assert.equal((await reusedPid.listEmulators())[0].managed, false)
      await assert.rejects(
        reusedPid.stopEmulator({ id: 'managed-avd' }),
        error => error.code === 'service.conflict'
      )
      assert.equal(active.get('managed-avd'), 'emulator-5554')
      assert.notEqual(secondOwner.ownerNonce, 'different-owner')
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
