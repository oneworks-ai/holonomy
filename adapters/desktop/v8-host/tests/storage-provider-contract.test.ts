import { describe, expect, it } from 'vitest'
import { storageCommandV1 } from '../../../../packages/capabilities/storage/src/host/admission.ts'
import { createHostStorageProvider } from '../../../../packages/capabilities/storage/src/host/storage-provider.ts'
import type { StorageHostProviderV1 } from '../../../../packages/capabilities/storage/src/host/types.ts'
import { STORAGE_LIMIT_MAXIMA_V2 } from '../../../../packages/capabilities/storage/src/kernel/storage-policy.ts'
import type {
  CapabilityProviderAuthorityV1,
  HoloInvocationContextV1
} from '../../../../packages/runtime/src/kernel/broker-types.ts'
import { sha256Hex } from '../../../../packages/runtime/src/module-loader/sha256.ts'
import { createNativeStorageProvider } from '../bootstrap/storage-provider.mjs'

const installation = { operations: ['v1.kv.set'], limits: { maxValueBytes: 2 } }
const policy = { access: 'sandboxed' as const, limits: { maxPendingOperations: 1 } }
const request = {
  module: 'host.storage',
  operation: 'v1.kv.set',
  args: { key: 'key' },
  binary: [{ handle: 'value', base64: 'AQ==' }]
}
const authority = {
  bindings: [{
    capabilityName: 'host.storage',
    providerModule: 'host.storage',
    constraints: {
      namespaceId: 'default',
      operations: ['storage.kv.set'],
      keyPrefixes: [''],
      databases: [],
      limits: { ...STORAGE_LIMIT_MAXIMA_V2, maxValueBytes: 1 }
    }
  }],
  complete: (result: unknown) => ({ result })
} as unknown as CapabilityProviderAuthorityV1

const context = (args: unknown, signal: AbortSignal, providerData?: unknown) =>
  ({
    arguments: args,
    signal,
    providerData,
    operation: 'storage.kv.set',
    resource: { requested: { kind: 'storageKv', namespaceId: 'default' } }
  }) as HoloInvocationContextV1

const kernel = (provider: StorageHostProviderV1, alter?: (args: Record<string, unknown>) => void) => ({
  invokeTracked(json: string, signal: AbortSignal) {
    const input = JSON.parse(json)
    alter?.(input.arguments)
    const result = Promise.resolve(
      provider.provider.invoke(context(input.arguments, signal, input.providerData), authority)
    )
      .then(terminal => JSON.stringify({ ok: true, value: terminal.result.value }))
    return { result, settled: result.then(() => undefined, () => undefined) }
  }
})

describe('shared Host Storage port contract', () => {
  it('keeps the Desktop name as the same shared factory', () => {
    expect(createNativeStorageProvider).toBe(createHostStorageProvider)
  })

  it('waits for a native terminal and sends the exact commitment with minimum selected limits', async () => {
    let finish!: (json: string) => void
    let command: Record<string, unknown> | undefined
    const provider = createHostStorageProvider(
      {
        storageCancel() {},
        storageStart(json) {
          command = JSON.parse(json)
          return {
            id: 7,
            promise: new Promise<string>(resolve => {
              finish = resolve
            })
          }
        }
      },
      installation,
      policy
    )
    try {
      let completed = false
      const pending = provider.dispatch(request, 'async', new AbortController().signal, kernel(provider))
        .then(value => {
          completed = true
          return value
        })
      await Promise.resolve()
      expect(completed).toBe(false)
      expect(command).toMatchObject({
        args: { key: 'key' },
        binary: [{ handle: 'value', base64: 'AQ==' }],
        callToken: 'async',
        valueByteLength: 1,
        valueSha256: sha256Hex(new Uint8Array([1])),
        selection: { limits: { maxValueBytes: 1 } }
      })
      finish(JSON.stringify({ value: { ok: true, value: null } }))
      expect(await pending).toEqual({ value: { ok: true, value: null } })
    } finally {
      provider.close()
    }
  })

  it.each(['valueByteLength', 'valueSha256'])('rejects middleware tampering with %s before native I/O', async field => {
    let starts = 0
    const provider = createHostStorageProvider(
      {
        storageCancel() {},
        storageStart() {
          starts++
          throw new Error('must not start')
        }
      },
      installation,
      policy
    )
    try {
      const result = await provider.dispatch(
        request,
        field,
        new AbortController().signal,
        kernel(provider, args => {
          args[field] = field === 'valueByteLength' ? 2 : '0'.repeat(64)
        })
      )
      expect(result).toEqual({ value: { ok: false, error: { code: 'storage.invalid_argument' } } })
      expect(starts).toBe(0)
    } finally {
      provider.close()
    }
  })

  it.each([false, true])('zeroes consumed staged bytes on admission (invalid=%s)', invalid => {
    const bytes = new Uint8Array([1])
    const args = {
      key: 'key',
      namespaceId: 'default',
      valueByteLength: 1,
      valueSha256: invalid ? '0'.repeat(64) : sha256Hex(bytes)
    }
    const run = () =>
      storageCommandV1(context(args, new AbortController().signal), authority, installation, [{
        handle: 'value',
        data: bytes
      }], 'cleanup')
    if (invalid) expect(run).toThrow()
    else expect(run().command).toContain('AQ==')
    expect(bytes).toEqual(new Uint8Array([0]))
  })

  it('cancels a live native job on close and rejects a late terminal without completing authority', async () => {
    let finish!: (json: string) => void
    const cancellations: number[] = []
    const provider = createHostStorageProvider(
      {
        storageCancel(id) {
          cancellations.push(id)
        },
        storageStart() {
          return {
            id: 19,
            promise: new Promise<string>(resolve => {
              finish = resolve
            })
          }
        }
      },
      installation,
      policy
    )
    const pending = provider.dispatch(request, 'close', new AbortController().signal, kernel(provider))
    provider.close()
    expect(cancellations).toEqual([19])
    finish(JSON.stringify({ value: { ok: true, value: null } }))
    expect(await pending).toEqual({ value: { ok: false, error: { code: 'storage.cancelled' } } })
    provider.close()
    expect(cancellations).toEqual([19])
  })

  it('redacts native start exceptions', async () => {
    const provider = createHostStorageProvider(
      {
        storageCancel() {},
        storageStart() {
          throw new Error('/private/platform/path')
        }
      },
      installation,
      policy
    )
    try {
      expect(await provider.dispatch(request, 'throw', new AbortController().signal, kernel(provider)))
        .toEqual({ value: { ok: false, error: { code: 'storage.internal' } } })
    } finally {
      provider.close()
    }
  })
})
