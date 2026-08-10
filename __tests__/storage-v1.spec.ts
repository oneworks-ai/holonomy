import { describe, expect, it } from 'vitest'

import {
  RuntimeEventLoop,
  STORAGE_OPERATIONS,
  createNativeBridge,
  createStorageAuthority,
  createStorageAuthorityRegistry,
  createStorageFacade,
  nativeAuthorityForStorage,
  requireStorageCredentialBinding,
  resolveProviderStorageAuthority,
  storageSuccess
} from '../src/index.js'
import { ControlledNativePort, VirtualNativeHost, providerToken } from './native-port-fixture.js'

import type { RuntimeEventLoop as RuntimeEventLoopType } from '../src/index.js'

const input = () => ({
  capabilities: ['host.storage.v1'],
  namespace: 'application-data',
  operations: [
    'credential.open',
    'credential.use',
    'kv.delete',
    'kv.get',
    'kv.list',
    'kv.set',
    'sqlite.execute',
    'sqlite.query',
    'sqlite.transaction'
  ] as const,
  principal: 'application'
})
const settle = async <T>(loop: RuntimeEventLoopType, promise: Promise<T>) => {
  let done = false
  let error: unknown
  let value!: T
  void promise.then(result => {
    done = true
    value = result
  }, failure => {
    done = true
    error = failure
  })
  for (let index = 0; index < 32; index += 1) {
    if (done) break
    if (loop.getSnapshot().hasPendingWork) loop.runTurn()
    await Promise.resolve()
  }
  if (error !== undefined) throw error
  if (!done) throw new Error('unsettled')
  return value
}
const setup = () => {
  const authority = createStorageAuthority(input())
  const loop = new RuntimeEventLoop(new VirtualNativeHost())
  const port = new ControlledNativePort()
  const bridge = createNativeBridge(port, { authority: nativeAuthorityForStorage(authority), eventLoop: loop })
  return { authority, bridge, facade: createStorageFacade({ authority: input(), bridge }), loop, port }
}

describe('storage v1 adversarial boundary', () => {
  it('uses the Native Bridge binary path and rejects malformed unary attachments', async () => {
    const test = setup()
    const pending = test.facade.kv.get('key')
    const call = test.port.calls.at(-1)
    expect(call?.request.operation).toBe(STORAGE_OPERATIONS.kvGet)
    call?.sink({
      id: call.request.id,
      resources: [{ providerToken: providerToken('unexpected'), type: 'storage.credential' }],
      type: 'result',
      value: storageSuccess(null)
    })
    test.loop.runTurn()
    await expect(settle(test.loop, pending)).rejects.toMatchObject({ code: 'storage.protocol_error' })
    expect(test.port.closedResources).toHaveLength(1)
  })

  it('keeps facade authority/bridge and credential handle opaque while preserving exact binding', async () => {
    const test = setup()
    expect(Object.keys(test.facade)).toEqual(['credentials', 'kv', 'sqlite'])
    expect(Reflect.ownKeys(test.facade)).toEqual(['credentials', 'kv', 'sqlite'])
    const opening = test.facade.credentials.open('credential')
    const open = test.port.calls.at(-1)
    open?.sink({
      id: open.request.id,
      resources: [{ providerToken: providerToken('credential'), type: 'storage.credential' }],
      type: 'result',
      value: storageSuccess(true)
    })
    test.loop.runTurn()
    const credential = await settle(test.loop, opening)
    expect(Reflect.ownKeys(credential)).toEqual([])
    const pending = credential.withBytes(bytes => bytes)
    const use = test.port.calls.at(-1)
    const registry = createStorageAuthorityRegistry([test.authority])
    expect(resolveProviderStorageAuthority(registry, use?.context as never, 'credential.use')).toBe(test.authority)
    expect(requireStorageCredentialBinding(use?.context as never, use?.request.args as never).reference).toBe(
      (use?.request.args as { credential: unknown }).credential
    )
    use?.sink({
      binary: [{ data: new Uint8Array([1, 2]), handle: 'secret' }],
      id: use.request.id,
      type: 'result',
      value: storageSuccess(true)
    })
    test.loop.runTurn()
    expect([...await settle(test.loop, pending)]).toEqual([0, 0])
  })

  it('fails closed despite mutable allowlist helpers and rejects credential decoys', () => {
    const original = Array.prototype.includes
    // eslint-disable-next-line no-extend-native -- adversarial mutation fixture
    Array.prototype.includes = () => true
    try {
      expect(() => createStorageAuthority({ ...input(), capabilities: [], operations: ['invalid'] as never })).toThrow(
        /input is invalid/u
      )
    } finally {
      // eslint-disable-next-line no-extend-native -- restore adversarial mutation fixture
      Array.prototype.includes = original
    }
    const reference = { resource: 'credential' }
    const context = {
      authority: nativeAuthorityForStorage(createStorageAuthority(input())),
      callToken: 'call' as never,
      mode: 'result' as const,
      resources: [{
        ownerCallToken: 'owner' as never,
        providerToken: 'token' as never,
        reference,
        type: 'storage.credential'
      }]
    }
    expect(() => requireStorageCredentialBinding(context, { credential: reference, decoy: true } as never)).toThrow(
      /not authorized/u
    )
    expect(requireStorageCredentialBinding(context, { credential: reference })).toBe(context.resources[0])
  })

  it('rejects hostile binary values before Native Bridge admission', async () => {
    const test = setup()
    const hostile = new Proxy(new Uint8Array([1]), {
      get() {
        throw new Error('getter must not run')
      }
    })
    await expect(test.facade.kv.set('key', hostile as never)).rejects.toMatchObject({
      code: 'storage.invalid_argument'
    })
    expect(test.port.calls).toHaveLength(0)
  })

  it('preflights oversized binary and hostile transaction arrays before dispatch', async () => {
    const authority = createStorageAuthority({ ...input(), limits: { maxValueBytes: 1 } })
    const loop = new RuntimeEventLoop(new VirtualNativeHost())
    const port = new ControlledNativePort()
    const bridge = createNativeBridge(port, { authority: nativeAuthorityForStorage(authority), eventLoop: loop })
    const facade = createStorageFacade({ authority: { ...input(), limits: { maxValueBytes: 1 } }, bridge })
    await expect(facade.kv.set('key', new Uint8Array([1, 2]))).rejects.toMatchObject({
      code: 'storage.invalid_argument'
    })
    const hostile = new Proxy([], {
      getOwnPropertyDescriptor() {
        throw new Error('descriptor poison')
      }
    })
    await expect(facade.sqlite.transaction('main', hostile as never)).rejects.toMatchObject({
      code: 'storage.invalid_argument'
    })
    expect(port.calls).toHaveLength(0)
  })

  it('maps disposed by operation: open/KV are disposed, only withBytes is credential-closed', async () => {
    const test = setup()
    test.bridge.dispose()
    await expect(test.facade.credentials.open('credential')).rejects.toMatchObject({ code: 'storage.disposed' })
    await expect(test.facade.kv.get('key')).rejects.toMatchObject({ code: 'storage.disposed' })
  })

  it('uses the frozen transaction snapshot after admission', async () => {
    const test = setup()
    let postSnapshot = false
    const source = [{ sql: 'update table set value = 1' }]
    const statements = new Proxy(source, {
      getOwnPropertyDescriptor(target, key) {
        if (postSnapshot && key === 'length') throw new Error('post-snapshot-length-marker')
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    const pending = test.facade.sqlite.transaction('main', statements)
    postSnapshot = true
    const call = test.port.calls.at(-1)
    call?.sink({ id: call.request.id, type: 'result', value: storageSuccess([{ changes: 1 }]) })
    test.loop.runTurn()
    await expect(settle(test.loop, pending)).resolves.toEqual([{ changes: 1 }])
  })

  it('maps malformed KV and credential envelopes to protocol_error and releases outputs once', async () => {
    const test = setup()
    const kv = test.facade.kv.get('key')
    const kvCall = test.port.calls.at(-1)
    kvCall?.sink({ id: kvCall.request.id, type: 'result', value: { ok: true } })
    test.loop.runTurn()
    await expect(settle(test.loop, kv)).rejects.toMatchObject({ code: 'storage.protocol_error' })
    const opening = test.facade.credentials.open('credential')
    const open = test.port.calls.at(-1)
    open?.sink({
      id: open.request.id,
      resources: [{ providerToken: providerToken('credential-malformed'), type: 'storage.credential' }],
      type: 'result',
      value: storageSuccess(true)
    })
    test.loop.runTurn()
    const credential = await settle(test.loop, opening)
    const bytes = new Uint8Array([9])
    const use = credential.withBytes(value => value)
    const useCall = test.port.calls.at(-1)
    useCall?.sink({
      binary: [{ data: bytes, handle: 'secret' }],
      id: useCall.request.id,
      resources: [{ providerToken: providerToken('unexpected-malformed'), type: 'storage.credential' }],
      type: 'result',
      value: { ok: true }
    })
    test.loop.runTurn()
    await expect(settle(test.loop, use)).rejects.toMatchObject({ code: 'storage.protocol_error' })
    expect(test.port.closedResources).toHaveLength(1)
  })
})
