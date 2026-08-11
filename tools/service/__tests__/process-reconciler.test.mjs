import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { ProcessReconciler } from '../process-reconciler.mjs'

describe('persisted process reconciliation', () => {
  it('keeps unsupported and non-explicit adapter outcomes pending', async () => {
    const process = {
      deviceId: 'android:emulator-5554',
      generation: 1,
      id: 'process-persisted',
      state: 'lost',
      target: 'android'
    }
    let mode = 'unsupported'
    let cleaned = 0
    let pending = 0
    const reconciler = new ProcessReconciler({
      adapterDispatcher: {
        target: () => ({
          reconcileProcess: async () => {
            if (mode === 'unsupported') {
              throw Object.assign(new Error('unsupported'), { code: 'service.unsupported' })
            }
            return mode === 'cleaned' ? { cleaned: true } : undefined
          }
        })
      },
      onCleaned: async () => cleaned += 1,
      onPending: async () => pending += 1
    })
    await reconciler.open({ resources: { processes: { [process.id]: { ...process, cleanupPending: true } } } })
    assert.deepEqual({ cleaned, pending }, { cleaned: 0, pending: 1 })
    mode = 'implicit'
    await reconciler.devices([{ id: process.deviceId, state: 'online' }])
    assert.deepEqual({ cleaned, pending }, { cleaned: 0, pending: 2 })
    mode = 'cleaned'
    await reconciler.devices([{ id: process.deviceId, state: 'online' }])
    assert.deepEqual({ cleaned, pending }, { cleaned: 1, pending: 2 })
  })
})
