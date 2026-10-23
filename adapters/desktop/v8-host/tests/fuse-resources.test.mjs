import { describe, expect, it } from 'vitest'
import { V86_FUSE_OPERATIONS_V1 as op } from '../../../../backends/v86/host/fuse-protocol.mjs'
import { V86FuseBridgeV1 } from '../../../../backends/v86/host/fuse.mjs'

let unique = 0n
const text = value => new TextEncoder().encode(`${value}\0`)
const stat = (kind, size, mode = kind === 'directory' ? 0o040755 : 0o100644) => ({
  kind,
  size,
  mode,
  atimeNs: '1700000000123456789',
  mtimeNs: '1700000000987654321',
  ctimeNs: '1700000000000000001'
})
const bytes = (length, handle = 0n) => {
  const output = new Uint8Array(length)
  if (length >= 8) new DataView(output.buffer).setBigUint64(0, handle, true)
  return output
}
const invoke = (bridge, opcode, body = new Uint8Array(), nodeId = 1n, options = {}) => {
  const payload = new Uint8Array(40 + body.length)
  const view = new DataView(payload.buffer)
  view.setUint32(0, payload.length, true)
  view.setUint32(4, opcode, true)
  view.setBigUint64(8, ++unique, true)
  view.setBigUint64(16, nodeId, true)
  view.setUint32(32, options.pid ?? 42, true)
  payload.set(body, 40)
  return bridge.handle({
    environmentId: 'env',
    executableId: 'cat',
    generation: 1,
    linuxPid: 42,
    processId: 2,
    processResourceId: 'process-2',
    scope: 'processTree',
    payload,
    signal: new AbortController().signal,
    policy: {},
    ...(options.resolveLinuxProcessSource == null
      ? {}
      : { resolveLinuxProcessSource: options.resolveLinuxProcessSource })
  })
}
const code = response => new DataView(response.buffer, response.byteOffset).getInt32(4, true)
const id = response => new DataView(response.buffer, response.byteOffset).getBigUint64(16, true)

describe('shared v86 FUSE ownership and quotas', () => {
  it('releases owned and late-open file bindings when a VM closes', async () => {
    const released = []
    let resolve
    const bridge = new V86FuseBridgeV1(input => {
      if (input.operation === 'lookup') return stat('file', 1)
      return resolve == null ? 'file-1' : new Promise(done => {
        resolve = done
      })
    }, { releaseFileHandle: token => released.push(token) })
    const node = id(await invoke(bridge, op.lookup, text('file')))
    expect(code(await invoke(bridge, op.open, bytes(8), node))).toBe(0)
    resolve = true
    const late = invoke(bridge, op.open, bytes(8), node)
    await Promise.resolve()
    bridge.releaseEnvironment('env')
    expect(released).toEqual(['file-1'])
    resolve('late-file')
    expect(code(await late)).toBe(-9)
    expect(released).toEqual(['file-1', 'late-file'])
  })

  it('reserves directory slots before readdir and releases them on close', async () => {
    let reads = 0
    const bridge = new V86FuseBridgeV1(() => {
      reads++
      return { handle: `directory-${reads}`, entries: [] }
    })
    const handles = []
    for (let index = 0; index < 64; index++) handles.push(id(await invoke(bridge, op.opendir, bytes(8))))
    expect(code(await invoke(bridge, op.opendir, bytes(8)))).toBe(-24)
    expect(reads).toBe(64)
    expect(code(await invoke(bridge, op.releasedir, bytes(8, handles[0])))).toBe(0)
    expect(code(await invoke(bridge, op.opendir, bytes(8)))).toBe(0)
    bridge.releaseEnvironment('env')
  })

  it('bounds aggregate directory snapshots', async () => {
    const bridge = new V86FuseBridgeV1(() => ({
      handle: 'directory-token',
      entries: Array.from({ length: 1024 }, (_, index) => ({ name: `n${index}`, kind: 'file' }))
    }))
    for (let index = 0; index < 7; index++) expect(code(await invoke(bridge, op.opendir, bytes(8)))).toBe(0)
    expect(code(await invoke(bridge, op.opendir, bytes(8)))).toBe(-28)
    bridge.releaseEnvironment('env')
    expect(code(await invoke(bridge, op.opendir, bytes(8)))).toBe(0)
    bridge.releaseEnvironment('env')
  })

  it('keeps the pinned directory binding through a known rename and closes it on RELEASEDIR', async () => {
    const calls = []
    const released = []
    const bridge = new V86FuseBridgeV1(input => {
      calls.push(input)
      if (input.operation === 'lookup') return stat('directory', 0)
      if (input.operation === 'opendir') return { handle: 'pinned-directory', entries: [] }
      return null
    }, { releaseFileHandle: token => released.push(token) })
    const node = id(await invoke(bridge, op.lookup, text('subdir')))
    const handle = id(await invoke(bridge, op.opendir, bytes(8), node))
    const names = new TextEncoder().encode('subdir\0moved\0')
    const rename = new Uint8Array(8 + names.byteLength)
    new DataView(rename.buffer).setBigUint64(0, 1n, true)
    rename.set(names, 8)
    expect(code(await invoke(bridge, op.rename, rename))).toBe(0)
    expect(code(await invoke(bridge, op.fsyncdir, bytes(16, handle), node))).toBe(0)
    expect(calls.at(-1)).toMatchObject({
      operation: 'fsyncdir',
      path: '/workspace/moved',
      handle: 'pinned-directory'
    })
    expect(code(await invoke(bridge, op.releasedir, bytes(8, handle), node))).toBe(0)
    expect(calls.at(-1)).toMatchObject({ operation: 'releasedir', handle: 'pinned-directory' })
    expect(released).toEqual(['pinned-directory'])
    expect(code(await invoke(bridge, op.fsyncdir, bytes(16, handle), node))).toBe(-9)
    bridge.releaseEnvironment('env')
    expect(released).toEqual(['pinned-directory'])
  })

  it('releases directory bindings on invalid snapshots and late opens after VM close', async () => {
    const released = []
    let resolve
    const bridge = new V86FuseBridgeV1(input => {
      if (input.operation !== 'opendir') return null
      if (resolve == null) return { handle: 'invalid-directory', entries: [{ name: 'bad', kind: 'unknown' }] }
      return new Promise(done => {
        resolve = done
      })
    }, { releaseFileHandle: token => released.push(token) })
    expect(code(await invoke(bridge, op.opendir, bytes(8)))).toBe(-5)
    expect(released).toEqual(['invalid-directory'])
    resolve = true
    const late = invoke(bridge, op.opendir, bytes(8))
    await Promise.resolve()
    bridge.releaseEnvironment('env')
    resolve({ handle: 'late-directory', entries: [] })
    expect(code(await late)).toBe(-9)
    expect(released).toEqual(['invalid-directory', 'late-directory'])
  })

  it('retires a directory binding once when RELEASEDIR races VM close', async () => {
    const released = []
    let finishClose
    const bridge = new V86FuseBridgeV1(input => {
      if (input.operation === 'opendir') return { handle: 'racing-directory', entries: [] }
      if (input.operation === 'releasedir') {
        return new Promise(done => {
          finishClose = done
        })
      }
      return null
    }, { releaseFileHandle: token => released.push(token) })
    const handle = id(await invoke(bridge, op.opendir, bytes(8)))
    const closing = invoke(bridge, op.releasedir, bytes(8, handle))
    await Promise.resolve()
    bridge.releaseEnvironment('env')
    expect(released).toEqual(['racing-directory'])
    finishClose(null)
    expect(code(await closing)).toBe(0)
    expect(released).toEqual(['racing-directory'])
  })

  it('retires a directory binding when RENAME replaces its record during RELEASEDIR', async () => {
    const released = []
    let finishClose
    const bridge = new V86FuseBridgeV1(input => {
      if (input.operation === 'lookup') return stat('directory', 0)
      if (input.operation === 'opendir') return { handle: 'renaming-directory', entries: [] }
      if (input.operation === 'releasedir') {
        return new Promise(done => {
          finishClose = done
        })
      }
      return null
    }, { releaseFileHandle: token => released.push(token) })
    const node = id(await invoke(bridge, op.lookup, text('subdir')))
    const handle = id(await invoke(bridge, op.opendir, bytes(8), node))
    const closing = invoke(bridge, op.releasedir, bytes(8, handle), node)
    await Promise.resolve()
    const names = new TextEncoder().encode('subdir\0moved\0')
    const rename = new Uint8Array(8 + names.byteLength)
    new DataView(rename.buffer).setBigUint64(0, 1n, true)
    rename.set(names, 8)
    expect(code(await invoke(bridge, op.rename, rename))).toBe(0)
    finishClose(null)
    expect(code(await closing)).toBe(0)
    expect(released).toEqual(['renaming-directory'])
    expect(code(await invoke(bridge, op.fsyncdir, bytes(16, handle), node))).toBe(-9)
    bridge.releaseEnvironment('env')
    expect(released).toEqual(['renaming-directory'])
  })

  it('retires a file binding when RENAME replaces its record during RELEASE', async () => {
    const released = []
    let finishClose
    const bridge = new V86FuseBridgeV1(input => {
      if (input.operation === 'lookup') return stat('file', 1)
      if (input.operation === 'open') return 'renaming-file'
      if (input.operation === 'release') {
        return new Promise(done => {
          finishClose = done
        })
      }
      return null
    }, { releaseFileHandle: token => released.push(token) })
    const node = id(await invoke(bridge, op.lookup, text('file')))
    const handle = id(await invoke(bridge, op.open, bytes(8), node))
    const closing = invoke(bridge, op.release, bytes(8, handle), node)
    await Promise.resolve()
    const names = new TextEncoder().encode('file\0moved\0')
    const rename = new Uint8Array(8 + names.byteLength)
    new DataView(rename.buffer).setBigUint64(0, 1n, true)
    rename.set(names, 8)
    expect(code(await invoke(bridge, op.rename, rename))).toBe(0)
    finishClose(null)
    expect(code(await closing)).toBe(0)
    expect(released).toEqual(['renaming-file'])
    bridge.releaseEnvironment('env')
    expect(released).toEqual(['renaming-file'])
  })

  it('reserves inode capacity before create/mkdir and rolls failed reservations back', async () => {
    let mutations = 0
    const bridge = new V86FuseBridgeV1(input => {
      if (input.operation === 'lookup') return stat('file', 1)
      mutations++
      throw Object.assign(new Error('denied'), { errno: 13 })
    })
    const create = name => {
      const value = new Uint8Array(16 + text(name).length)
      value.set(text(name), 16)
      return value
    }
    for (let index = 0; index < 4100; index++) {
      expect(code(await invoke(bridge, op.create, create(`bad${index}`)))).toBe(-13)
    }
    for (let index = 0; index < 4095; index++) expect(code(await invoke(bridge, op.lookup, text(`f${index}`)))).toBe(0)
    const before = mutations
    expect(code(await invoke(bridge, op.create, create('over')))).toBe(-28)
    const mkdir = new Uint8Array(8 + text('over').length)
    mkdir.set(text('over'), 8)
    expect(code(await invoke(bridge, op.mkdir, mkdir))).toBe(-28)
    expect(mutations).toBe(before)
    bridge.releaseEnvironment('env')
  })

  it('invalidates replaced target inode IDs without closing their pinned open tokens', async () => {
    const released = []
    const bridge = new V86FuseBridgeV1(input =>
      input.operation === 'lookup'
        ? stat('file', 1)
        : input.operation === 'open'
        ? 'old-target'
        : null, { releaseFileHandle: token => released.push(token) })
    await invoke(bridge, op.lookup, text('from'))
    const old = id(await invoke(bridge, op.lookup, text('to')))
    await invoke(bridge, op.open, bytes(8), old)
    const names = new TextEncoder().encode('from\0to\0')
    const rename = new Uint8Array(8 + names.length)
    new DataView(rename.buffer).setBigUint64(0, 1n, true)
    rename.set(names, 8)
    expect(code(await invoke(bridge, op.rename, rename))).toBe(0)
    expect(code(await invoke(bridge, op.getattr, new Uint8Array(), old))).toBe(-2)
    expect(released).toEqual([])
    bridge.releaseEnvironment('env')
    expect(released).toEqual(['old-target'])
  })

  it('returns the exact partial write count and retires the file handle on release', async () => {
    const released = []
    const calls = []
    const bridge = new V86FuseBridgeV1(input => {
      calls.push(input)
      if (input.operation === 'lookup') return stat('file', 6)
      if (input.operation === 'open') return 'opened-file'
      if (input.operation === 'write') return 3
      if (input.operation === 'read') return new TextEncoder().encode('xy')
      return null
    }, { releaseFileHandle: token => released.push(token) })
    const node = id(await invoke(bridge, op.lookup, text('file')))
    const handle = id(await invoke(bridge, op.open, bytes(8), node))
    const write = bytes(46, handle)
    const writeView = new DataView(write.buffer)
    writeView.setBigUint64(8, 4n, true)
    writeView.setUint32(16, 6, true)
    write.set(new TextEncoder().encode('abcdef'), 40)
    const response = await invoke(bridge, op.write, write, node)
    expect(code(response)).toBe(0)
    expect(new DataView(response.buffer, response.byteOffset).getUint32(16, true)).toBe(3)
    expect(calls.at(-1)).toMatchObject({ handle: 'opened-file', offset: 4, operation: 'write' })

    const read = bytes(40, handle)
    const readView = new DataView(read.buffer)
    readView.setBigUint64(8, 2n, true)
    readView.setUint32(16, 2, true)
    expect([...((await invoke(bridge, op.read, read, node)).slice(16))]).toEqual([120, 121])
    expect(code(await invoke(bridge, op.release, bytes(8, handle), node))).toBe(0)
    expect(released).toEqual(['opened-file'])
    expect(code(await invoke(bridge, op.read, read, node))).toBe(-9)
    bridge.releaseEnvironment('env')
    expect(released).toEqual(['opened-file'])
  })

  it('rejects an unrepresentable write offset before Provider mutation', async () => {
    const calls = []
    const bridge = new V86FuseBridgeV1(input => {
      calls.push(input)
      if (input.operation === 'lookup') return stat('file', 1)
      if (input.operation === 'open') return 'file-token'
      return 0
    })
    const node = id(await invoke(bridge, op.lookup, text('file')))
    const handle = id(await invoke(bridge, op.open, bytes(8), node))
    const write = bytes(40, handle)
    new DataView(write.buffer).setBigUint64(8, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true)
    const before = calls.length
    expect(code(await invoke(bridge, op.write, write, node))).toBe(-75)
    expect(calls).toHaveLength(before)
    bridge.releaseEnvironment('env')
  })

  it('forwards checked ACCESS and real file/directory sync requests', async () => {
    const calls = []
    const bridge = new V86FuseBridgeV1(input => {
      calls.push(input)
      if (input.operation === 'lookup') return stat('file', 1)
      if (input.operation === 'open') return 'file-token'
      if (input.operation === 'opendir') return { handle: 'directory-token', entries: [] }
      return null
    })
    const node = id(await invoke(bridge, op.lookup, text('file')))
    const handle = id(await invoke(bridge, op.open, bytes(8), node))
    const access = bytes(8)
    new DataView(access.buffer).setUint32(0, 6, true)
    expect(code(await invoke(bridge, op.access, access, node))).toBe(0)
    expect(calls.at(-1)).toMatchObject({ operation: 'access', mask: 6, path: '/workspace/file' })
    const fileSync = bytes(16, handle)
    new DataView(fileSync.buffer).setUint32(8, 1, true)
    expect(code(await invoke(bridge, op.fsync, fileSync, node))).toBe(0)
    expect(calls.at(-1)).toMatchObject({ operation: 'fsync', handle: 'file-token', datasync: true })
    const beforeFlush = calls.length
    expect(code(await invoke(bridge, op.flush, bytes(24, handle), node))).toBe(0)
    expect(code(await invoke(bridge, op.flush, bytes(8, handle), node))).toBe(-5)
    expect(calls).toHaveLength(beforeFlush)
    const directory = id(await invoke(bridge, op.opendir, bytes(8)))
    expect(code(await invoke(bridge, op.fsyncdir, bytes(16, directory)))).toBe(0)
    expect(calls.at(-1)).toMatchObject({
      operation: 'fsyncdir',
      path: '/workspace',
      datasync: false,
      handle: 'directory-token'
    })
    const before = calls.length
    expect(code(await invoke(bridge, op.fsync, bytes(16, directory)))).toBe(-9)
    expect(code(await invoke(bridge, op.fsyncdir, bytes(16, handle), node))).toBe(-9)
    expect(calls).toHaveLength(before)
    bridge.releaseEnvironment('env')
  })

  it('rejects mixed SETATTR before dispatch and forwards size or time changes with exact fields', async () => {
    const calls = []
    const bridge = new V86FuseBridgeV1(input => {
      calls.push(input)
      if (input.operation === 'lookup') return stat('file', 1)
      if (input.operation === 'open') return 'file-token'
      if (input.operation === 'setattr') return stat('file', input.size ?? 4)
      return null
    })
    const node = id(await invoke(bridge, op.lookup, text('file')))
    const handle = id(await invoke(bridge, op.open, bytes(8), node))
    const size = new Uint8Array(88)
    const sizeView = new DataView(size.buffer)
    sizeView.setUint32(0, 8 | 64 | 512, true)
    sizeView.setBigUint64(8, handle, true)
    sizeView.setBigUint64(16, 17n, true)
    expect(code(await invoke(bridge, op.setattr, size, node))).toBe(0)
    expect(calls.at(-1)).toMatchObject({ operation: 'setattr', handle: 'file-token', size: 17 })
    const before = calls.length
    sizeView.setUint32(0, 8 | 16 | 64, true)
    expect(code(await invoke(bridge, op.setattr, size, node))).not.toBe(0)
    expect(calls).toHaveLength(before)

    const times = new Uint8Array(88)
    const timeView = new DataView(times.buffer)
    timeView.setUint32(0, 16 | 32 | 64 | 128, true)
    timeView.setBigUint64(8, handle, true)
    timeView.setBigUint64(40, 1700000000n, true)
    timeView.setUint32(60, 123456789, true)
    expect(code(await invoke(bridge, op.setattr, times, node))).toBe(0)
    expect(calls.at(-1)).toMatchObject({
      operation: 'setattr',
      handle: 'file-token',
      atime: { kind: 'now' },
      mtime: { kind: 'set', seconds: 1700000000, nanoseconds: 123456789 }
    })
    bridge.releaseEnvironment('env')
  })

  it('closes only an owned matching pid-zero kernel release without process attribution', async () => {
    const calls = []
    const released = []
    let attributions = 0
    const bridge = new V86FuseBridgeV1(input => {
      calls.push(input.operation)
      if (input.operation === 'lookup') return stat('file', 1)
      if (input.operation === 'open') return 'owned-file'
      if (input.operation === 'opendir') return { handle: 'owned-directory', entries: [] }
      return null
    }, { releaseFileHandle: token => released.push(token) })
    const resolver = () => {
      attributions++
      throw Object.assign(new Error('pid zero has no guest owner'), { errno: 5 })
    }
    const kernel = { pid: 0, resolveLinuxProcessSource: resolver }
    const node = id(await invoke(bridge, op.lookup, text('file')))
    const file = id(await invoke(bridge, op.open, bytes(8), node))
    const directory = id(await invoke(bridge, op.opendir, bytes(8)))
    const before = calls.length
    expect(code(await invoke(bridge, op.release, bytes(24, file), 1n, kernel))).toBe(-9)
    expect(code(await invoke(bridge, op.releasedir, bytes(24, file), node, kernel))).toBe(-9)
    expect(code(await invoke(bridge, op.release, bytes(24, 999n), node, kernel))).toBe(-9)
    expect(released).toEqual([])
    expect(code(await invoke(bridge, op.release, bytes(24, file), node, kernel))).toBe(0)
    expect(code(await invoke(bridge, op.releasedir, bytes(24, directory), 1n, kernel))).toBe(0)
    expect(released).toEqual(['owned-file', 'owned-directory'])
    expect(calls).toHaveLength(before)
    expect(attributions).toBe(0)
    expect(code(await invoke(bridge, op.access, bytes(8), 1n, kernel))).toBe(-5)
    expect(attributions).toBe(1)
    bridge.releaseEnvironment('env')
    expect(released).toEqual(['owned-file', 'owned-directory'])
  })
})
