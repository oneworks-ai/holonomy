import assert from 'node:assert/strict'

import { STORAGE_LIMIT_MAXIMA_V2 } from '@holonomyjs/capability-storage'
import { test } from 'vitest'

import { createAndroidStorageProvider } from '../../src/runtimeBootstrap/android-storage-provider.mjs'

const flush = async () => {
  for (let turn = 0; turn < 30; turn++) await Promise.resolve()
}

// The real shared provider and Android adapter, with a native seam that never
// sends a cancel terminal. This tests logical settlement, not physical IO exit.
test.each([false, true])(
  'cancel releases the lease and ignores late native results (throws=%s)',
  async cancelThrows => {
    const starts = []
    const cancellations = []
    const terminals = []
    const adapter = createAndroidStorageProvider({
      nativeConfiguration: () =>
        JSON.stringify({
          capabilities: ['host.storage.v1'],
          storage: { namespace: 'default', operations: ['v1.kv.get'], limits: { maxPendingOperations: 1 } }
        }),
      storageStart(id, command) {
        starts.push({ id, command })
        return true
      },
      storageCancel(token) {
        cancellations.push(token)
        if (cancelThrows) throw new Error('native cancel failed')
      },
      emitStorageGuest(token, terminal) {
        terminals.push({ token, value: JSON.parse(terminal) })
      }
    }, { access: 'sandboxed', limits: { maxPendingOperations: 1 } })
    const authority = {
      bindings: [{
        capabilityName: 'host.storage',
        providerModule: 'host.storage',
        constraints: {
          namespaceId: 'default',
          operations: ['storage.kv.get'],
          keyPrefixes: [''],
          databases: [],
          limits: STORAGE_LIMIT_MAXIMA_V2
        }
      }],
      complete: result => ({ result })
    }
    const kernel = {
      invokeTracked(source, signal) {
        const input = JSON.parse(source)
        const result = Promise.resolve(adapter.provider.invoke({
          arguments: input.arguments,
          signal,
          providerData: input.providerData,
          operation: 'storage.kv.get',
          resource: { requested: { kind: 'storageKv', namespaceId: 'default' } }
        }, authority)).then(
          terminal => JSON.stringify({ ok: true, value: terminal.result.value }),
          error => JSON.stringify({ ok: false, error: { code: error.code ?? 'provider.protocol_error' } })
        )
        return { result, settled: result.then(() => undefined) }
      }
    }
    const request = JSON.stringify({ module: 'host.storage', operation: 'v1.kv.get', args: { key: 'k' } })
    try {
      adapter.dispatch('first', request, kernel)
      await flush()
      adapter.dispatch('blocked', request, kernel)
      await flush()
      assert.equal(terminals.find(item => item.token === 'blocked').value.value.error.code, 'storage.limit_exceeded')
      adapter.cancel('first')
      await flush()
      adapter.completeNative(starts[0].id, JSON.stringify({ value: { ok: true, value: null } }))
      adapter.dispatch('second', request, kernel)
      await flush()
      assert.equal(starts.length, 2)
      adapter.completeNative(starts[1].id, JSON.stringify({ value: { ok: true, value: null } }))
      await flush()
      assert.equal(terminals.filter(item => item.token === 'first').length, 1)
      assert.equal(terminals.find(item => item.token === 'first').value.value.error.code, 'storage.cancelled')
      assert.equal(terminals.find(item => item.token === 'second').value.value.ok, true)
      assert.deepEqual(cancellations, ['first'])
    } finally {
      adapter.close()
      await flush()
    }
  }
)
