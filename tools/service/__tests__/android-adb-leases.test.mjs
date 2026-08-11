import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { AndroidAdbLeaseStore } from '../android-adb-lease-store.mjs'
import { AndroidSessionCommandPort } from '../android-command-port.mjs'
import { ANDROID_CONTROL_ENDPOINT, AndroidControlChannel } from '../android-control-channel.mjs'

describe('persistent Android ADB leases', () => {
  it('adopts control forwards and removes process-scoped forwards and reverses', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-adb-leases-'))
    const stateFile = join(directory, 'adb-leases.json')
    const calls = []
    const runAdb = async args => {
      calls.push(args)
      if (args.includes(ANDROID_CONTROL_ENDPOINT)) return '2\n123\nholonomy.session.persisted\n'
      if (args.includes('pidof')) return '123\n'
      if (args.includes('tcp:0')) return '41000\n'
      return ''
    }
    try {
      const first = new AndroidControlChannel({
        exchange: async () => ({ ack: { accepted: true } }),
        leaseStore: new AndroidAdbLeaseStore({ file: stateFile }),
        runAdb
      })
      await first.send('emulator-5554', { command: 'status' })
      const second = new AndroidControlChannel({
        exchange: async () => ({ ack: { accepted: true } }),
        leaseStore: new AndroidAdbLeaseStore({ file: stateFile }),
        runAdb
      })
      await second.send('emulator-5554', { command: 'status' })
      assert.equal(calls.filter(args => args.includes('tcp:0')).length, 1)
      await second.close()

      const executeCalls = []
      const port = new AndroidSessionCommandPort({
        adb: 'adb',
        build: false,
        execute: async (_file, args) => {
          executeCalls.push(args)
          return args.includes('tcp:0') ? '42000\n' : ''
        },
        leaseStore: new AndroidAdbLeaseStore({ file: stateFile })
      })
      await port.forwardInspector('emulator-5554', 'inspector.socket', {
        generation: 3,
        processId: 'process-persisted'
      })
      await port.reverse('emulator-5554', 43_210, {
        generation: 3,
        processId: 'process-persisted'
      })
      const failingExecute = async (_file, args) => {
        executeCalls.push(args)
        if (args.includes('--remove')) throw new Error('adb remove failed')
        if (args.includes('--list') && args.includes('forward')) {
          return 'emulator-5554 tcp:42000 localabstract:inspector.socket\n'
        }
        if (args.includes('--list') && args.includes('reverse')) {
          return 'emulator-5554 tcp:43210 tcp:43210\n'
        }
        return ''
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const failed = new AndroidSessionCommandPort({
          adb: 'adb',
          build: false,
          execute: failingExecute,
          leaseStore: new AndroidAdbLeaseStore({ file: stateFile })
        })
        await assert.rejects(failed.cleanupProcess('process-persisted', 3), /adb remove failed/u)
        const retained = new AndroidAdbLeaseStore({ file: stateFile })
        await retained.open()
        assert.equal(retained.list(lease => lease.processId === 'process-persisted').length, 2)
      }
      const recovered = new AndroidSessionCommandPort({
        adb: 'adb',
        build: false,
        execute: async (_file, args) => {
          executeCalls.push(args)
          return ''
        },
        leaseStore: new AndroidAdbLeaseStore({ file: stateFile })
      })
      assert.equal(await recovered.cleanupProcess('process-persisted', 3), 2)
      const empty = new AndroidAdbLeaseStore({ file: stateFile })
      await empty.open()
      assert.equal(empty.list(lease => lease.processId === 'process-persisted').length, 0)

      await empty.add({
        generation: 4,
        kind: 'inspector-forward',
        localPort: 43_000,
        processId: 'process-already-absent',
        serial: 'emulator-5554',
        socketName: 'absent.socket'
      })
      const alreadyAbsent = new AndroidSessionCommandPort({
        adb: 'adb',
        build: false,
        execute: async (_file, args) => {
          if (args.includes('--remove')) throw new Error('mapping was already absent')
          return ''
        },
        leaseStore: new AndroidAdbLeaseStore({ file: stateFile })
      })
      await alreadyAbsent.removeForward('emulator-5554', 43_000)
      const verified = new AndroidAdbLeaseStore({ file: stateFile })
      await verified.open()
      assert.equal(verified.list(lease => lease.processId === 'process-already-absent').length, 0)
      assert.ok(executeCalls.some(args => args.includes('forward') && args.includes('--remove')))
      assert.ok(executeCalls.some(args => args.includes('reverse') && args.includes('--remove')))
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('retains a control forward when cleanup cannot verify that it is absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-control-lease-'))
    const stateFile = join(directory, 'adb-leases.json')
    try {
      const store = new AndroidAdbLeaseStore({ file: stateFile })
      await store.open()
      await store.add({
        kind: 'control-forward',
        localPort: 44_000,
        serial: 'emulator-5554',
        socketName: 'control.persisted'
      })
      const failed = new AndroidControlChannel({
        exchange: async () => ({ ack: { accepted: true } }),
        leaseStore: new AndroidAdbLeaseStore({ file: stateFile }),
        runAdb: async args => {
          if (args.includes('--remove')) throw new Error('remove unavailable')
          if (args.includes('--list')) {
            return 'emulator-5554 tcp:44000 localabstract:control.persisted\n'
          }
          return ''
        }
      })
      await assert.rejects(failed.close(), /remove unavailable/u)
      const retained = new AndroidAdbLeaseStore({ file: stateFile })
      await retained.open()
      assert.equal(retained.list(lease => lease.kind === 'control-forward').length, 1)

      const recovered = new AndroidControlChannel({
        exchange: async () => ({ ack: { accepted: true } }),
        leaseStore: new AndroidAdbLeaseStore({ file: stateFile }),
        runAdb: async () => ''
      })
      await recovered.close()
      const empty = new AndroidAdbLeaseStore({ file: stateFile })
      await empty.open()
      assert.equal(empty.list(lease => lease.kind === 'control-forward').length, 0)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('rejects a stale persisted endpoint before creating or exchanging a forward', async () => {
    const calls = []
    let exchanges = 0
    const channel = new AndroidControlChannel({
      exchange: async () => {
        exchanges += 1
        return { ack: { accepted: true } }
      },
      runAdb: async args => {
        calls.push(args)
        if (args.includes(ANDROID_CONTROL_ENDPOINT)) return '2\n123\nholonomy.session.stale\n'
        if (args.includes('pidof')) return '456\n'
        return '41000\n'
      }
    })

    await assert.rejects(
      channel.send('emulator-5554', { command: 'status' }),
      error => error.code === 'service.unavailable' && error.message === 'Android control endpoint is stale'
    )
    assert.equal(exchanges, 0)
    assert.equal(calls.some(args => args.includes('tcp:0')), false)
  })

  it('aborts an active control exchange without retrying the device endpoint', async () => {
    const controller = new AbortController()
    const calls = []
    let exchanges = 0
    let markExchangeStarted
    const exchangeStarted = new Promise(resolve => {
      markExchangeStarted = resolve
    })
    const channel = new AndroidControlChannel({
      exchange: async (_port, _command, _timeoutMs, signal) => {
        exchanges += 1
        markExchangeStarted()
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        })
      },
      runAdb: async args => {
        calls.push(args)
        if (args.includes(ANDROID_CONTROL_ENDPOINT)) return '2\n123\nholonomy.session.active\n'
        if (args.includes('pidof')) return '123\n'
        return '41000\n'
      }
    })

    const pending = channel.send('emulator-5554', { command: 'status' }, { signal: controller.signal })
    await exchangeStarted
    controller.abort()
    await assert.rejects(pending, /cancelled/u)
    assert.equal(exchanges, 1)
    assert.equal(calls.filter(args => args.includes('tcp:0')).length, 1)
  })
})
