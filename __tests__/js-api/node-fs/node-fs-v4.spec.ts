import { describe, expect, it } from 'vitest'

import {
  RuntimeEventLoop,
  createFsAuthority,
  createNativeBridge,
  createNodeFsFacade,
  nativeAuthorityForFs
} from '../../../src/index.js'
import { settle, setupMemoryFs } from '../../../tests/fixtures/holonomy-fs.js'

describe('node-fs V4 native bridge conformance', () => {
  it('enforces virtual root traversal and stable domain errors', async () => {
    const { fs, loop } = setupMemoryFs()
    await expect(settle(loop, fs.promises.readFile('holonomy-fs://workspace/missing'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(fs.promises.mkdir('holonomy-fs://workspace/%2e%2e/escape')).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(fs.promises.mkdir('/data/user/0/escape')).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('uses Bridge-issued opaque resources for FileHandle calls and closes exactly once', async () => {
    const { fs, loop, port } = setupMemoryFs()
    const handle = await settle(loop, fs.promises.open('holonomy-fs://workspace/data.bin', 'w+'))
    await settle(loop, handle.write(new Uint8Array([1, 2, 3, 4])))
    const buffer = new Uint8Array(4)
    await settle(loop, handle.read(buffer, 0, 4, 0))
    expect([...buffer]).toEqual([1, 2, 3, 4])
    await handle.close()
    await handle.close()
    expect(port.getSnapshot().openHandles).toBe(0)
    await expect(handle.read(buffer)).rejects.toMatchObject({ code: 'EBADF' })
  })

  it('streams large reads through V4 credit/backpressure and permits cancellation', async () => {
    const { fs, loop, port } = setupMemoryFs()
    await settle(loop, fs.promises.writeFile('holonomy-fs://workspace/large.txt', 'abcdefgh'))
    const stream = fs.createReadStream('holonomy-fs://workspace/large.txt')
    const first = stream.next()
    expect(port.getSnapshot().pendingStreams).toBe(1)
    const firstResult = await settle(loop, first)
    expect(firstResult.done).toBe(false)
    expect([...firstResult.value!]).toEqual([97, 98, 99, 100])
    const controller = new AbortController()
    const cancelled = fs.createReadStream('holonomy-fs://workspace/large.txt', { signal: controller.signal })
    const pending = cancelled.next()
    controller.abort()
    await expect(settle(loop, pending)).rejects.toMatchObject({ code: 'ECANCELED' })
  })

  it('resolves symlinks only inside an authority and honors O_NOFOLLOW', async () => {
    const { fs, loop } = setupMemoryFs()
    await settle(loop, fs.promises.writeFile('holonomy-fs://workspace/target.txt', 'ok'))
    await settle(loop, fs.promises.symlink('holonomy-fs://workspace/target.txt', 'holonomy-fs://workspace/link.txt'))
    await expect(settle(loop, fs.promises.open('holonomy-fs://workspace/link.txt', 0x20000))).rejects.toMatchObject({
      code: 'EPERM'
    })
    const linkStat = await settle(loop, fs.promises.lstat('holonomy-fs://workspace/link.txt'))
    expect(linkStat.isSymbolicLink()).toBe(true)
    await expect(settle(loop, fs.promises.symlink('holonomy-fs://app-data/target', 'holonomy-fs://workspace/x')))
      .rejects
      .toMatchObject({ code: 'EXDEV' })
  })

  it('delivers watch events only after a stream credit is granted', async () => {
    const { fs, loop } = setupMemoryFs()
    await settle(loop, fs.promises.writeFile('holonomy-fs://workspace/watched.txt', 'before'))
    const watcher = fs.watch('holonomy-fs://workspace/')
    const event = watcher.next()
    await settle(loop, fs.promises.writeFile('holonomy-fs://workspace/watched.txt', 'after'))
    await expect(settle(loop, event)).resolves.toMatchObject({
      done: false,
      value: { eventType: 'change', filename: 'watched.txt' }
    })
    watcher.close()
  })

  it('rechecks root permissions, quotas and cross-authority boundaries', async () => {
    const limited = setupMemoryFs({ limits: { maxOpenHandles: 1 } })
    const first = await settle(limited.loop, limited.fs.promises.open('holonomy-fs://workspace/one.txt', 'w'))
    await expect(settle(limited.loop, limited.fs.promises.open('holonomy-fs://workspace/two.txt', 'w'))).rejects
      .toMatchObject({ code: 'ENOSPC' })
    await first.close()

    await expect(settle(
      limited.loop,
      limited.fs.promises.rename(
        'holonomy-fs://workspace/one.txt',
        'holonomy-fs://app-data/one.txt'
      )
    )).rejects.toMatchObject({ code: 'EXDEV' })

    const readOnly = setupMemoryFs({ permissions: ['metadata', 'read'] })
    const denied = settle(readOnly.loop, readOnly.fs.promises.writeFile('holonomy-fs://workspace/nope.txt', 'x'))
    await expect(denied).rejects.toMatchObject({ code: 'EACCES' })
    await expect(denied).rejects.not.toMatchObject({ message: expect.stringContaining('workspace-1') })

    await expect(settle(
      readOnly.loop,
      readOnly.fs.promises.chmod(
        'holonomy-fs://workspace/nope.txt',
        0o600
      )
    )).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('supports O_DIRECTORY, follows only intermediate nofollow links, and snapshots guest options', async () => {
    const { fs, loop } = setupMemoryFs()
    await settle(loop, fs.promises.mkdir('holonomy-fs://workspace/directory'))
    const directory = await settle(
      loop,
      fs.promises.open('holonomy-fs://workspace/directory', fs.constants.O_DIRECTORY)
    )
    const directoryStat = await settle(loop, directory.stat())
    expect(directoryStat.isDirectory()).toBe(true)
    await directory.close()
    await settle(loop, fs.promises.writeFile('holonomy-fs://workspace/file.txt', 'x'))
    await expect(settle(loop, fs.promises.open('holonomy-fs://workspace/file.txt', fs.constants.O_DIRECTORY))).rejects
      .toMatchObject({ code: 'ENOTDIR' })
    await expect(settle(
      loop,
      fs.promises.open(
        'holonomy-fs://workspace/no-ghost',
        fs.constants.O_CREAT | fs.constants.O_DIRECTORY
      )
    )).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(settle(loop, fs.promises.stat('holonomy-fs://workspace/no-ghost'))).rejects
      .toMatchObject({ code: 'ENOENT' })

    const hostile = {}
    Object.defineProperty(hostile, 'timeoutMs', { enumerable: true, get: () => 1 })
    await expect(fs.promises.stat('holonomy-fs://workspace/file.txt', hostile as never)).rejects
      .toMatchObject({ code: 'EINVAL' })
    await expect(fs.promises.stat('holonomy-fs://workspace/file.txt', { unknown: true } as never)).rejects
      .toMatchObject({ code: 'EINVAL' })
  })

  it('keeps prior contents when an opaque atomic write cannot complete', async () => {
    const { fs, loop, port } = setupMemoryFs({ limits: { maxFileBytes: 4 } })
    await settle(loop, fs.promises.writeFile('holonomy-fs://workspace/atomic.txt', 'old'))
    await expect(settle(loop, fs.promises.writeFile('holonomy-fs://workspace/atomic.txt', 'toolong'))).rejects
      .toMatchObject({ code: 'ENOSPC' })
    await expect(settle(loop, fs.promises.readFile('holonomy-fs://workspace/atomic.txt', { encoding: 'utf8' })))
      .resolves.toBe('old')
    await expect(settle(loop, fs.promises.readdir('holonomy-fs://workspace/'))).resolves
      .toEqual(['atomic.txt'])

    const controller = new AbortController()
    controller.abort()
    await expect(settle(
      loop,
      fs.promises.writeFile('holonomy-fs://workspace/never-created.txt', 'x', { signal: controller.signal })
    )).rejects.toMatchObject({ code: 'ECANCELED' })
    await expect(settle(loop, fs.promises.readdir('holonomy-fs://workspace/'))).resolves
      .toEqual(['atomic.txt'])
    expect(port.getSnapshot()).toMatchObject({
      openHandles: 0,
      pendingTransactions: 0,
      transactionBytes: 0
    })
  })

  it('closes rogue unary and stream resource grants before surfacing EIO', async () => {
    let cancelled = 0
    let closed = 0
    let streamId: string | undefined
    let streamSink: ((event: unknown) => void) | undefined
    const port = {
      cancel() {
        cancelled += 1
      },
      closeResource() {
        closed += 1
      },
      dispose() {},
      dispatch(request: { id: string; operation: string }, _context: unknown, sink: (event: unknown) => void) {
        if (request.operation === 'v1.read-stream') {
          streamId = request.id
          streamSink = sink
          return
        }
        sink({
          id: request.id,
          resources: [{ providerToken: 'rogue', type: 'fs.file' }],
          type: 'result',
          value: { ok: true, value: { birthtimeMs: 0, ctimeMs: 0, kind: 'file', mode: 0o600, mtimeMs: 0, size: 0 } }
        })
      },
      grantCredits(_callToken: unknown, _credits: number) {
        streamSink?.({
          binary: [{ data: new Uint8Array([1]), handle: 'data' }],
          id: streamId,
          resources: [{ providerToken: 'rogue-stream', type: 'fs.file' }],
          sequence: 0,
          type: 'chunk',
          value: { ok: true }
        })
      }
    }
    const host = { checkpointMicrotasks() {}, now: () => 0, requestWakeup() {}, terminate() {} }
    const loop = new RuntimeEventLoop(host)
    const authority = createFsAuthority({
      capabilities: ['host.fs.v1'],
      principal: 'rogue-test',
      roots: { workspace: { permissions: ['metadata', 'read', 'write'], rootId: 'rogue-root' } }
    })
    const bridge = createNativeBridge(port as never, { authority: nativeAuthorityForFs(authority), eventLoop: loop })
    const fs = createNodeFsFacade(bridge, { now: loop.getCurrentTime.bind(loop) })
    await expect(settle(loop, fs.promises.stat('holonomy-fs://workspace/a'))).rejects.toMatchObject({ code: 'EIO' })
    expect(closed).toBe(1)
    expect(bridge.getSnapshot().openResources).toBe(0)
    expect(cancelled).toBe(0)

    const stream = fs.createReadStream('holonomy-fs://workspace/a')
    await expect(settle(loop, stream.next())).rejects.toMatchObject({ code: 'EIO' })
    expect(closed).toBe(2)
    expect(cancelled).toBe(1)
    expect(bridge.getSnapshot().openResources).toBe(0)
  })

  it('maps V4 deadlines to a redacted ETIMEDOUT error and disposes streams', async () => {
    const { bridge, fs, host, loop, port } = setupMemoryFs()
    await settle(loop, fs.promises.writeFile('holonomy-fs://workspace/timeout.txt', 'pending'))
    const watcher = fs.watch('holonomy-fs://workspace/timeout.txt', { timeoutMs: 10 })
    const pending = watcher.next()
    host.advanceTo(10)
    await expect(settle(loop, pending)).rejects.toMatchObject({
      code: 'ETIMEDOUT',
      message: 'File system operation timed out'
    })
    expect(port.getSnapshot().pendingStreams).toBe(0)

    const second = fs.createReadStream('holonomy-fs://workspace/timeout.txt')
    const cancelled = second.next()
    bridge.dispose()
    await expect(settle(loop, cancelled)).rejects.toMatchObject({ code: 'EBADF' })
  })
})
