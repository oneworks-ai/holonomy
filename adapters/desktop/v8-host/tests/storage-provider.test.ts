import { describe, expect, it } from 'vitest'

import { STORAGE_LIMIT_MAXIMA_V2 } from '../../../../packages/capabilities/storage/src/kernel/storage-policy.ts'

import { createNativeStorageProvider } from '../bootstrap/storage-provider.mjs'

const installation = {
  limits: {},
  operations: ['v1.kv.set']
}
const policy = { access: 'sandboxed', limits: { maxPendingOperations: 128 } }
const authority = {
  bindings: [{
    capabilityName: 'host.storage',
    constraints: {
      databases: [],
      keyPrefixes: [''],
      limits: STORAGE_LIMIT_MAXIMA_V2,
      namespaceId: 'default',
      operations: ['storage.kv.set']
    },
    providerModule: 'host.storage'
  }],
  complete: (result: unknown) => ({ result })
}

const fakeKernel = (
  provider: ReturnType<typeof createNativeStorageProvider>,
  delay?: (token: string) => Promise<void>
) => ({
  invokeTracked(json: string, signal: AbortSignal) {
    const result = (async () => {
      const input = JSON.parse(json)
      const token = input.providerData.storageCallToken
      await delay?.(token)
      const terminal = await provider.provider.invoke({
        arguments: input.arguments,
        operation: 'storage.kv.set',
        providerData: input.providerData,
        resource: { requested: { kind: 'storageKv', namespaceId: 'default' } },
        signal
      } as never, authority as never) as { result: { value: unknown } }
      return JSON.stringify({ ok: true, value: terminal.result.value })
    })()
    return { result, settled: result.then(() => undefined, () => undefined) }
  }
})

describe('native Storage Provider payload binding', () => {
  it('keeps concurrent same-key, same-length writes bound to their original call tokens', async () => {
    const starts: Record<string, unknown>[] = []
    const provider = createNativeStorageProvider(
      {
        storageCancel() {},
        storageStart(json: string) {
          const call = JSON.parse(json)
          starts.push(call)
          return { id: starts.length, promise: Promise.resolve(JSON.stringify({ value: { ok: true, value: null } })) }
        }
      },
      installation,
      policy
    )
    let releaseFirst: (() => void) | undefined
    const firstWait = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const kernel = fakeKernel(provider, token => token === 'first' ? firstWait : Promise.resolve())
    const request = (byte: number) => ({
      args: { key: 'same' },
      binary: [{ handle: 'value', base64: byte === 1 ? 'AQ==' : 'Ag==' }],
      module: 'host.storage',
      operation: 'v1.kv.set'
    })
    const first = provider.dispatch(request(1), 'first', new AbortController().signal, kernel)
    const second = provider.dispatch(request(2), 'second', new AbortController().signal, kernel)
    expect((await second).value).toEqual({ ok: true, value: null })
    releaseFirst?.()
    expect((await first).value).toEqual({ ok: true, value: null })
    expect(starts.map(item => [item.callToken, (item.binary as { base64: string }[])[0]?.base64])).toEqual([
      ['second', 'Ag=='],
      ['first', 'AQ==']
    ])
    provider.close()
  })

  it('cancels the matching Rust job and suppresses a late success', async () => {
    let complete: ((value: string) => void) | undefined
    let cancelled: number | undefined
    const provider = createNativeStorageProvider(
      {
        storageCancel(id: number) {
          cancelled = id
        },
        storageStart() {
          return {
            id: 42,
            promise: new Promise<string>(resolve => {
              complete = resolve
            })
          }
        }
      },
      installation,
      policy
    )
    const controller = new AbortController()
    const pending = provider.dispatch(
      {
        args: { key: 'same' },
        binary: [{ handle: 'value', base64: 'AQ==' }],
        module: 'host.storage',
        operation: 'v1.kv.set'
      },
      'cancelled',
      controller.signal,
      fakeKernel(provider)
    )
    for (let index = 0; index < 10; index++) await Promise.resolve()
    expect(complete).toBeTypeOf('function')
    controller.abort()
    expect(cancelled).toBe(42)
    complete?.(JSON.stringify({ value: { ok: true, value: null } }))
    await expect(pending).resolves.toEqual({ value: { ok: false, error: { code: 'storage.cancelled' } } })
    provider.close()
  })

  it('enforces Host operation and result caps on a plugin short circuit without Rust I/O', async () => {
    let starts = 0
    const provider = createNativeStorageProvider(
      {
        storageCancel() {},
        storageStart() {
          starts += 1
          throw new Error('must not run')
        }
      },
      { operations: ['v1.kv.get'], limits: { maxValueBytes: 1 } },
      policy
    )
    const kernel = {
      invokeTracked() {
        return {
          result: Promise.resolve(JSON.stringify({ ok: true, value: { found: true, valueBase64: 'AQI=' } })),
          settled: Promise.resolve()
        }
      }
    }
    const get = await provider.dispatch(
      {
        args: { key: 'key' },
        module: 'host.storage',
        operation: 'v1.kv.get'
      },
      'short-circuit',
      new AbortController().signal,
      kernel
    )
    expect(get.value).toEqual({ ok: false, error: { code: 'storage.limit_exceeded' } })
    const denied = await provider.dispatch(
      {
        args: { key: 'key' },
        binary: [{ handle: 'value', base64: 'AQ==' }],
        module: 'host.storage',
        operation: 'v1.kv.set'
      },
      'uninstalled',
      new AbortController().signal,
      kernel
    )
    expect(denied.value).toEqual({ ok: false, error: { code: 'storage.authorization_denied' } })
    expect(starts).toBe(0)
    provider.close()
  })

  it('drops an aborted staged value before delayed middleware reaches the Provider', async () => {
    let starts = 0
    let release: (() => void) | undefined
    const wait = new Promise<void>(resolve => {
      release = resolve
    })
    const provider = createNativeStorageProvider(
      {
        storageCancel() {},
        storageStart() {
          starts += 1
          throw new Error('late start')
        }
      },
      installation,
      policy
    )
    const controller = new AbortController()
    const pending = provider.dispatch(
      {
        args: { key: 'same' },
        binary: [{ handle: 'value', base64: 'AQ==' }],
        module: 'host.storage',
        operation: 'v1.kv.set'
      },
      'late',
      controller.signal,
      fakeKernel(provider, () => wait)
    )
    controller.abort()
    release?.()
    await expect(pending).resolves.toEqual({ value: { ok: false, error: { code: 'storage.cancelled' } } })
    expect(starts).toBe(0)
    provider.close()
  })

  it.each([
    { hostCap: 4, policyCap: 1 },
    { hostCap: 1, policyCap: 4 }
  ])('holds the effective pending slot through tracked settlement (%o)', async ({ hostCap, policyCap }) => {
    let finishResult: ((value: string) => void) | undefined
    let finishSettled: (() => void) | undefined
    let calls = 0
    const firstResult = new Promise<string>(resolve => {
      finishResult = resolve
    })
    const firstSettled = new Promise<void>(resolve => {
      finishSettled = resolve
    })
    const kernel = {
      invokeTracked() {
        calls += 1
        if (calls === 1) return { result: firstResult, settled: firstSettled }
        return {
          result: Promise.resolve(JSON.stringify({ ok: true, value: { found: false } })),
          settled: Promise.resolve()
        }
      }
    }
    const provider = createNativeStorageProvider({ storageCancel() {} }, {
      limits: { maxPendingOperations: hostCap },
      operations: ['v1.kv.get']
    }, { access: 'sandboxed', limits: { maxPendingOperations: policyCap } })
    const request = { args: { key: 'key' }, module: 'host.storage', operation: 'v1.kv.get' }
    const first = provider.dispatch(request, 'first', new AbortController().signal, kernel)
    expect((await provider.dispatch(request, 'second', new AbortController().signal, kernel)).value)
      .toEqual({ ok: false, error: { code: 'storage.limit_exceeded' } })
    expect(calls).toBe(1)
    finishResult?.(JSON.stringify({ ok: true, value: { found: false } }))
    expect((await first).value).toEqual({ ok: true, value: null })
    expect((await provider.dispatch(request, 'third', new AbortController().signal, kernel)).value)
      .toEqual({ ok: false, error: { code: 'storage.limit_exceeded' } })
    expect(calls).toBe(1)
    finishSettled?.()
    await Promise.resolve()
    expect((await provider.dispatch(request, 'fourth', new AbortController().signal, kernel)).value)
      .toEqual({ ok: true, value: null })
    expect(calls).toBe(2)
    provider.close()
  })

  it('lets the Kernel report Policy denial under a physical installation', async () => {
    let calls = 0
    const provider = createNativeStorageProvider({ storageCancel() {} }, {
      limits: { maxPendingOperations: 1 },
      operations: ['v1.kv.get']
    }, { access: 'none' })
    const kernel = {
      invokeTracked() {
        calls += 1
        return {
          result: Promise.resolve(JSON.stringify({ ok: false, error: { code: 'holo.policy_denied' } })),
          settled: Promise.resolve()
        }
      }
    }
    const request = { args: { key: 'key' }, module: 'host.storage', operation: 'v1.kv.get' }
    expect((await provider.dispatch(request, 'first', new AbortController().signal, kernel)).value)
      .toEqual({ ok: false, error: { code: 'storage.authorization_denied' } })
    expect((await provider.dispatch(request, 'second', new AbortController().signal, kernel)).value)
      .toEqual({ ok: false, error: { code: 'storage.authorization_denied' } })
    expect(calls).toBe(2)
    provider.close()
  })

  it('keeps a denied call in the slot until detached settlement while clearing its staged bytes', async () => {
    let settleFirst: (() => void) | undefined
    let calls = 0
    let starts = 0
    const firstSettled = new Promise<void>(resolve => {
      settleFirst = resolve
    })
    const provider = createNativeStorageProvider(
      {
        storageCancel() {},
        storageStart() {
          starts += 1
          throw new Error('late I/O')
        }
      },
      { operations: ['v1.kv.set'], limits: { maxPendingOperations: 1 } },
      policy
    )
    const kernel = {
      invokeTracked() {
        calls += 1
        return {
          result: Promise.resolve(JSON.stringify({ ok: false, error: { code: 'holo.permission_denied' } })),
          settled: calls === 1 ? firstSettled : Promise.resolve()
        }
      }
    }
    const request = {
      args: { key: 'same' },
      binary: [{ handle: 'value', base64: 'AQ==' }],
      module: 'host.storage',
      operation: 'v1.kv.set'
    }
    expect((await provider.dispatch(request, 'first', new AbortController().signal, kernel)).value)
      .toEqual({ ok: false, error: { code: 'storage.authorization_denied' } })
    await expect(provider.provider.invoke({
      operation: 'storage.kv.set',
      providerData: { storageCallToken: 'first' },
      signal: new AbortController().signal
    } as never, authority as never)).rejects.toMatchObject({ code: 'provider.protocol_error' })
    expect((await provider.dispatch(request, 'second', new AbortController().signal, kernel)).value)
      .toEqual({ ok: false, error: { code: 'storage.limit_exceeded' } })
    expect(calls).toBe(1)
    settleFirst?.()
    await Promise.resolve()
    expect((await provider.dispatch(request, 'third', new AbortController().signal, kernel)).value)
      .toEqual({ ok: false, error: { code: 'storage.authorization_denied' } })
    expect(calls).toBe(2)
    expect(starts).toBe(0)
    provider.close()
  })

  it('retains the slot after public cancellation until the tracked frame settles', async () => {
    let finishResult: ((value: string) => void) | undefined
    let finishSettled: (() => void) | undefined
    let calls = 0
    const firstResult = new Promise<string>(resolve => {
      finishResult = resolve
    })
    const firstSettled = new Promise<void>(resolve => {
      finishSettled = resolve
    })
    const provider = createNativeStorageProvider({ storageCancel() {} }, {
      limits: { maxPendingOperations: 1 },
      operations: ['v1.kv.get']
    }, policy)
    const kernel = {
      invokeTracked() {
        calls += 1
        return calls === 1
          ? { result: firstResult, settled: firstSettled }
          : {
            result: Promise.resolve(JSON.stringify({ ok: true, value: { found: false } })),
            settled: Promise.resolve()
          }
      }
    }
    const request = { args: { key: 'key' }, module: 'host.storage', operation: 'v1.kv.get' }
    const controller = new AbortController()
    const first = provider.dispatch(request, 'first', controller.signal, kernel)
    controller.abort()
    finishResult?.(JSON.stringify({ ok: false, error: { code: 'holo.operation_cancelled' } }))
    expect((await first).value).toEqual({ ok: false, error: { code: 'storage.cancelled' } })
    expect((await provider.dispatch(request, 'second', new AbortController().signal, kernel)).value)
      .toEqual({ ok: false, error: { code: 'storage.limit_exceeded' } })
    finishSettled?.()
    await Promise.resolve()
    expect((await provider.dispatch(request, 'third', new AbortController().signal, kernel)).value)
      .toEqual({ ok: true, value: null })
    expect(calls).toBe(2)
    provider.close()
  })
})
