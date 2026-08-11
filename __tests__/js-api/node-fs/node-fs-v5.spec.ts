import { describe, expect, it } from 'vitest'

import {
  FS_NATIVE_MODULE,
  FS_OPERATIONS,
  MemoryFsNativePort,
  RuntimeEventLoop,
  createFsAuthority,
  createNativeBridge,
  createNodeFsFacade,
  nativeAuthorityForFs
} from '../../../src/index.js'
import { parseFsResourceResult, parseFsResultWithoutResources } from '../../../src/node-fs/contract.js'
import { settle, setupMemoryFs } from '../../../tests/fixtures/holonomy-fs.js'

import type {
  HostEventLoopPort,
  NativeArgumentValue,
  NativeBinary,
  NativeBridge,
  NativePort,
  NativeResourceHandle
} from '../../../src/index.js'

let nextRequestId = 1

const request = (
  bridge: NativeBridge,
  operation: string,
  args: NativeArgumentValue,
  binary?: readonly NativeBinary[]
) =>
  bridge.request({
    args,
    ...(binary == null ? {} : { binary }),
    id: `fs-v5:${nextRequestId++}`,
    module: FS_NATIVE_MODULE,
    operation
  })

const beginTransaction = async (
  bridge: NativeBridge,
  loop: RuntimeEventLoop,
  path: string
) => {
  const output = parseFsResourceResult(
    await settle(
      loop,
      request(
        bridge,
        FS_OPERATIONS.atomicWriteBegin,
        { flags: 0x241, mode: 0o666, path }
      )
    ),
    'writeFile'
  )
  expect(output.resources).toHaveLength(1)
  expect(output.resources?.[0]?.type).toBe('fs.atomic-write')
  return output.resources![0]!
}

const writeTransactionChunk = async (
  bridge: NativeBridge,
  loop: RuntimeEventLoop,
  transaction: NativeResourceHandle,
  data: Uint8Array
) =>
  parseFsResultWithoutResources(
    await settle(
      loop,
      request(
        bridge,
        FS_OPERATIONS.atomicWriteChunk,
        { transaction },
        [{ data, handle: 'data' }]
      )
    ),
    'writeFile'
  )

const commitTransaction = async (
  bridge: NativeBridge,
  loop: RuntimeEventLoop,
  transaction: NativeResourceHandle
) =>
  parseFsResultWithoutResources(
    await settle(
      loop,
      request(
        bridge,
        FS_OPERATIONS.atomicWriteCommit,
        { transaction }
      )
    ),
    'writeFile'
  )

describe('node-fs V5 opaque atomic write conformance', () => {
  it('does not use guest staging names or Math.random', async () => {
    const { fs, loop, port } = setupMemoryFs()
    await settle(
      loop,
      fs.promises.writeFile('holonomy-fs://workspace/.holonomy-fs-tx-collision', 'sentinel')
    )
    const descriptor = Object.getOwnPropertyDescriptor(Math, 'random')!
    Object.defineProperty(Math, 'random', {
      configurable: true,
      value: () => {
        throw new Error('hostile random')
      }
    })
    try {
      await settle(
        loop,
        fs.promises.writeFile('holonomy-fs://workspace/result.txt', 'written')
      )
    } finally {
      Object.defineProperty(Math, 'random', descriptor)
    }
    await expect(settle(
      loop,
      fs.promises.readFile('holonomy-fs://workspace/.holonomy-fs-tx-collision', { encoding: 'utf8' })
    )).resolves.toBe('sentinel')
    await expect(settle(
      loop,
      fs.promises.readFile('holonomy-fs://workspace/result.txt', { encoding: 'utf8' })
    )).resolves.toBe('written')
    await expect(settle(loop, fs.promises.readdir('holonomy-fs://workspace/'))).resolves
      .toEqual(['.holonomy-fs-tx-collision', 'result.txt'])
    expect(port.getSnapshot()).toMatchObject({
      openHandles: 0,
      pendingTransactions: 0,
      transactionBytes: 0
    })
  })

  it('keeps private transaction bytes outside the directory namespace', async () => {
    const { bridge, fs, loop, port } = setupMemoryFs()
    const transaction = await beginTransaction(
      bridge,
      loop,
      'holonomy-fs://workspace/private-bytes.txt'
    )
    await writeTransactionChunk(
      bridge,
      loop,
      transaction,
      new Uint8Array([1, 2, 3, 4])
    )
    expect(port.getSnapshot()).toMatchObject({
      entries: 1,
      pendingTransactions: 1,
      transactionBytes: 4
    })
    await expect(settle(loop, fs.promises.readdir('holonomy-fs://workspace/'))).resolves
      .toEqual([])
    expect(transaction.close('abort')).toBe(true)
    expect(transaction.close('duplicate_abort')).toBe(false)
    await expect(settle(loop, fs.promises.readdir('holonomy-fs://workspace/'))).resolves
      .toEqual([])
    expect(port.getSnapshot()).toMatchObject({
      openHandles: 0,
      pendingTransactions: 0,
      transactionBytes: 0
    })

    const disposed = await beginTransaction(
      bridge,
      loop,
      'holonomy-fs://workspace/disposed.txt'
    )
    await writeTransactionChunk(
      bridge,
      loop,
      disposed,
      new Uint8Array([5, 6])
    )
    bridge.dispose()
    expect(port.getSnapshot()).toMatchObject({
      disposed: true,
      openHandles: 0,
      pendingTransactions: 0,
      transactionBytes: 0
    })
  })

  it('rolls back an undelivered begin grant and a cancelled mutated chunk', async () => {
    const { bridge, fs, loop, port } = setupMemoryFs()
    const preDelivery = new AbortController()
    const neverVisible = fs.promises.writeFile(
      'holonomy-fs://workspace/never-visible.txt',
      'value',
      { signal: preDelivery.signal }
    )
    expect(port.getSnapshot()).toMatchObject({ openHandles: 1, pendingTransactions: 1 })
    preDelivery.abort()
    await expect(settle(loop, neverVisible)).rejects.toMatchObject({ code: 'ECANCELED' })
    expect(port.getSnapshot()).toMatchObject({
      openHandles: 0,
      pendingTransactions: 0,
      transactionBytes: 0
    })

    await settle(loop, fs.promises.writeFile('holonomy-fs://workspace/old.txt', 'old'))
    const midWrite = new AbortController()
    const pending = fs.promises.writeFile(
      'holonomy-fs://workspace/old.txt',
      'abcdefgh',
      { signal: midWrite.signal }
    )
    loop.runTurn()
    await Promise.resolve()
    await Promise.resolve()
    expect(port.getSnapshot()).toMatchObject({
      pendingTransactions: 1,
      transactionBytes: 4
    })
    expect(bridge.getSnapshot()).toMatchObject({ pendingRequests: 1 })
    midWrite.abort()
    await expect(settle(loop, pending)).rejects.toMatchObject({ code: 'ECANCELED' })
    await expect(settle(
      loop,
      fs.promises.readFile('holonomy-fs://workspace/old.txt', { encoding: 'utf8' })
    )).resolves.toBe('old')
    await expect(settle(loop, fs.promises.readdir('holonomy-fs://workspace/'))).resolves
      .toEqual(['old.txt'])
    expect(port.getSnapshot()).toMatchObject({
      openHandles: 0,
      pendingTransactions: 0,
      transactionBytes: 0
    })
  })

  it('shares one absolute deadline and releases retained transaction quota', async () => {
    const { fs, host, loop, port } = setupMemoryFs()
    await settle(loop, fs.promises.writeFile('holonomy-fs://workspace/deadline.txt', 'old'))
    const pending = fs.promises.writeFile(
      'holonomy-fs://workspace/deadline.txt',
      'abcdefgh',
      { timeoutMs: 1001 }
    )
    loop.runTurn()
    await Promise.resolve()
    await Promise.resolve()
    expect(port.getSnapshot().transactionBytes).toBe(4)
    host.advanceTo(1001)
    await expect(settle(loop, pending)).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    await expect(settle(
      loop,
      fs.promises.readFile('holonomy-fs://workspace/deadline.txt', { encoding: 'utf8' })
    )).resolves.toBe('old')
    expect(port.getSnapshot()).toMatchObject({
      openHandles: 0,
      pendingTransactions: 0,
      transactionBytes: 0
    })

    const quota = setupMemoryFs({ limits: { maxTotalBytes: 6 } })
    await settle(quota.loop, quota.fs.promises.writeFile('holonomy-fs://workspace/quota.txt', 'old'))
    await expect(settle(
      quota.loop,
      quota.fs.promises.writeFile('holonomy-fs://workspace/quota.txt', 'more')
    )).rejects.toMatchObject({ code: 'ENOSPC' })
    await expect(settle(
      quota.loop,
      quota.fs.promises.readFile('holonomy-fs://workspace/quota.txt', { encoding: 'utf8' })
    )).resolves.toBe('old')
    expect(quota.port.getSnapshot()).toMatchObject({
      pendingTransactions: 0,
      totalBytes: 3,
      transactionBytes: 0
    })
  })

  it('makes commit-vs-cancel atomic and terminal operations idempotent', async () => {
    const { bridge, fs, loop, port } = setupMemoryFs()
    await settle(loop, fs.promises.writeFile('holonomy-fs://workspace/race.txt', 'old'))
    const controller = new AbortController()
    const pending = fs.promises.writeFile(
      'holonomy-fs://workspace/race.txt',
      'new!',
      { signal: controller.signal }
    )
    loop.runTurn()
    await Promise.resolve()
    await Promise.resolve()
    loop.runTurn()
    await Promise.resolve()
    await Promise.resolve()
    expect(port.getSnapshot()).toMatchObject({ openHandles: 1, pendingTransactions: 0 })
    expect(bridge.getSnapshot().pendingRequests).toBe(1)
    controller.abort()
    await expect(settle(loop, pending)).rejects.toMatchObject({ code: 'ECANCELED' })
    await expect(settle(
      loop,
      fs.promises.readFile('holonomy-fs://workspace/race.txt', { encoding: 'utf8' })
    )).resolves.toBe('new!')
    expect(port.getSnapshot().openHandles).toBe(0)

    const transaction = await beginTransaction(
      bridge,
      loop,
      'holonomy-fs://workspace/direct.txt'
    )
    await writeTransactionChunk(bridge, loop, transaction, new Uint8Array([1]))
    await commitTransaction(bridge, loop, transaction)
    await expect(commitTransaction(bridge, loop, transaction)).rejects
      .toMatchObject({ code: 'EBADF' })
    expect(transaction.close('first_abort_after_commit')).toBe(true)
    expect(transaction.close('duplicate_abort')).toBe(false)
    expect(port.getSnapshot()).toMatchObject({ openHandles: 0, pendingTransactions: 0 })
  })

  it('rejects forged and cross-authority transaction resources', async () => {
    const ownerAuthority = createFsAuthority({
      capabilities: ['host.fs.v1'],
      principal: 'transaction-owner',
      roots: {
        workspace: {
          permissions: ['metadata', 'read', 'write'],
          rootId: 'owner-workspace'
        }
      }
    })
    const attackerAuthority = createFsAuthority({
      capabilities: ['host.fs.v1'],
      principal: 'transaction-attacker',
      roots: {
        'app-data': {
          permissions: ['metadata', 'read', 'write'],
          rootId: 'attacker-app-data'
        }
      }
    })
    const host: HostEventLoopPort = {
      checkpointMicrotasks() {},
      now: () => 0,
      requestWakeup() {},
      terminate() {}
    }
    const loop = new RuntimeEventLoop(host)
    const port = new MemoryFsNativePort({
      authorities: [ownerAuthority, attackerAuthority]
    })
    const bridge = createNativeBridge(port, {
      authority: nativeAuthorityForFs(ownerAuthority),
      eventLoop: loop
    })
    const transaction = await beginTransaction(
      bridge,
      loop,
      'holonomy-fs://workspace/private.txt'
    )
    expect(Reflect.ownKeys(transaction)).not.toContain('providerToken')
    expect(Reflect.ownKeys(transaction)).not.toContain('token')

    await expect(settle(
      loop,
      request(
        bridge,
        FS_OPERATIONS.atomicWriteChunk,
        { transaction: { close() {}, type: 'fs.atomic-write' } as never },
        [{ data: new Uint8Array([1]), handle: 'data' }]
      )
    )).rejects.toMatchObject({ code: 'invalid_value' })

    const secondBridge = createNativeBridge(port, {
      authority: nativeAuthorityForFs(attackerAuthority),
      eventLoop: loop
    })
    await expect(settle(
      loop,
      request(
        secondBridge,
        FS_OPERATIONS.atomicWriteChunk,
        { transaction },
        [{ data: new Uint8Array([1]), handle: 'data' }]
      )
    )).rejects.toMatchObject({ code: 'resource_invalid' })
    transaction.close('test_complete')
    secondBridge.dispose()
    expect(port.getSnapshot()).toMatchObject({ openHandles: 0, pendingTransactions: 0 })
  })

  it('redacts provider throws and rolls back the provider-owned transaction', async () => {
    const authority = createFsAuthority({
      capabilities: ['host.fs.v1'],
      principal: 'throwing-provider',
      roots: {
        workspace: {
          permissions: ['metadata', 'read', 'write'],
          rootId: 'throwing-root'
        }
      }
    })
    const basePort = new MemoryFsNativePort({ authorities: [authority] })
    const port: NativePort = {
      cancel: (...args) => basePort.cancel(...args),
      closeResource: (...args) => basePort.closeResource(...args),
      dispatch(requestValue, context, sink, resourceSink) {
        if (requestValue.operation === FS_OPERATIONS.atomicWriteChunk) {
          basePort.dispatch(requestValue, context, () => {}, resourceSink)
          throw new Error('/native/private/path')
        }
        return basePort.dispatch(requestValue, context, sink, resourceSink)
      },
      dispose: () => basePort.dispose(),
      grantCredits: (...args) => basePort.grantCredits(...args)
    }
    const host: HostEventLoopPort = {
      checkpointMicrotasks() {},
      now: () => 0,
      requestWakeup() {},
      terminate() {}
    }
    const loop = new RuntimeEventLoop(host)
    const bridge = createNativeBridge(port, {
      authority: nativeAuthorityForFs(authority),
      eventLoop: loop
    })
    const fs = createNodeFsFacade(bridge, {
      chunkBytes: 4,
      now: loop.getCurrentTime.bind(loop)
    })
    await expect(settle(
      loop,
      fs.promises.writeFile('holonomy-fs://workspace/throw.txt', 'value')
    )).rejects.toMatchObject({
      code: 'EIO',
      message: 'File system provider failed'
    })
    expect(basePort.getSnapshot()).toMatchObject({
      entries: 1,
      openHandles: 0,
      pendingTransactions: 0,
      transactionBytes: 0
    })
  })
})
