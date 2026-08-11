import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { createAdbPort } from '../adb-port.mjs'
import { HolonomyControlCore } from '../control-core.mjs'
import { serviceError } from '../errors.mjs'
import { ServiceLogStore } from '../service-log-store.mjs'
import { AtomicServiceStateStore } from '../state-store.mjs'

const waitForOperation = async (core, id) => {
  for (let turn = 0; turn < 2_000; turn += 1) {
    const operation = core.get('operations', id, 'Operation')
    if (['cancelled', 'failed', 'succeeded'].includes(operation.state)) return operation
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('Operation did not settle')
}

describe('process operation cancellation', () => {
  it('preempts an active start when the same generation is stopped', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-start-cancel-'))
    let releaseStarted
    const started = new Promise(resolve => {
      releaseStarted = resolve
    })
    let stopCalls = 0
    const core = new HolonomyControlCore({
      adbPort: createAdbPort({
        listDevices: async () => [{
          id: 'android:emulator-5554',
          kind: 'emulator',
          serial: 'emulator-5554',
          state: 'online'
        }],
        startProcess: async ({ signal }) =>
          await new Promise((_resolve, reject) => {
            releaseStarted()
            signal.addEventListener('abort', () => {
              reject(serviceError('service.unavailable', 'cancelled start'))
            }, { once: true })
          }),
        stopProcess: async () => {
          stopCalls += 1
        }
      }),
      logStore: new ServiceLogStore({ directory: join(directory, 'logs') }),
      store: new AtomicServiceStateStore({ directory })
    })
    try {
      await core.open()
      await core.refreshDevices()
      const admission = await core.startProcess({
        deviceId: 'android:emulator-5554',
        entryUrl: 'app+local://workspace/entry.mjs',
        inspectorMode: 'off',
        isolation: 'runtime',
        launch: { modules: [] },
        target: 'android'
      }, 'preempt-start')
      await started
      const stopped = await core.stopProcess(
        admission.value.process.id,
        admission.value.process.generation,
        'preempt-stop'
      )
      assert.equal((await waitForOperation(core, admission.value.operation.id)).state, 'cancelled')
      assert.equal((await waitForOperation(core, stopped.value.operation.id)).state, 'succeeded')
      assert.equal(core.get('processes', admission.value.process.id, 'Runtime process').state, 'cancelled')
      assert.equal(stopCalls, 1)
    } finally {
      await core.close()
      await rm(directory, { force: true, recursive: true })
    }
  })
})
