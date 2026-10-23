/* eslint-disable max-lines -- One bounded FUSE environment owns its inode/handle wire state. */
import {
  V86_FUSE_OPERATIONS_V1,
  decodeV86FuseAccessV1,
  decodeV86FuseFsyncV1,
  decodeV86FuseRequestV1,
  decodeV86FuseSetattrV1,
  encodeV86FuseAttrV1,
  encodeV86FuseDirectoryV1,
  encodeV86FuseEntryV1,
  encodeV86FuseErrorV1,
  encodeV86FuseInitV1,
  encodeV86FuseOpenV1,
  encodeV86FuseResultV1,
  encodeV86FuseStatfsV1,
  encodeV86FuseWriteV1,
  fuseBodyViewV1,
  fuseNameV1,
  fuseNamesV1
} from './fuse-protocol.mjs'

const errno = error => {
  const value = Number(error?.errno)
  return Number.isInteger(value) && value > 0 && value <= 4095 ? value : 5
}

const safeOffset = view => {
  const value = view.getBigUint64(8, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw Object.assign(new RangeError('FUSE offset exceeds safe integer range'), { errno: 75 })
  }
  return Number(value)
}

const metadata = value => {
  if (
    value == null || typeof value !== 'object' ||
    !['directory', 'file'].includes(value.kind) ||
    !Number.isSafeInteger(value.size) || value.size < 0 ||
    !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o177777 ||
    (value.mode & 0o170000) !== (value.kind === 'directory' ? 0o040000 : 0o100000) ||
    ['atimeNs', 'mtimeNs', 'ctimeNs'].some(field =>
      typeof value[field] !== 'string' || !/^(?:0|-?[1-9]\d{0,20})$/.test(value[field])
    )
  ) throw Object.assign(new TypeError('Invalid v86 FUSE metadata'), { errno: 5 })
  return Object.freeze({
    kind: value.kind,
    size: value.size,
    mode: value.mode,
    atimeNs: value.atimeNs,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs
  })
}

class V86FuseEnvironmentBridgeV1 {
  #dispatch
  #release
  #closed = false
  #pendingHandles = 0
  #directoryEntries = 0
  #directoryBytes = 0
  #handles = new Map()
  #inodes = new Map([[1n, '/workspace']])
  #inodeKinds = new Map([[1n, 'directory']])
  #inodeIds = new Map([['/workspace', 1n]])
  #pendingInodes = new Map()
  #nextHandle = 1n
  #nextInode = 2n

  constructor(dispatch, release) {
    if (typeof dispatch !== 'function') throw new TypeError('Invalid v86 FUSE dispatch')
    this.#dispatch = dispatch
    this.#release = release
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const [id, handle] of this.#handles) this.#retireHandle(id, handle)
    this.#inodes.clear()
    this.#inodeKinds.clear()
    this.#inodeIds.clear()
    this.#pendingInodes.clear()
    this.#directoryEntries = 0
    this.#directoryBytes = 0
  }

  async handle(input) {
    const request = decodeV86FuseRequestV1(input.payload)
    try {
      if (this.#closed) return encodeV86FuseErrorV1(request, 9)
      if (
        request.pid === 0 &&
        (request.opcode === V86_FUSE_OPERATIONS_V1.release ||
          request.opcode === V86_FUSE_OPERATIONS_V1.releasedir)
      ) return this.#releaseWithoutProcess(request)
      const attributed = typeof input.resolveLinuxProcessSource === 'function'
        ? input.resolveLinuxProcessSource(request.pid)
        : input
      const common = Object.freeze({
        environmentId: input.environmentId,
        executableId: attributed.executableId,
        generation: input.generation,
        linuxPid: request.pid,
        policy: input.policy,
        processId: input.processId,
        processResourceId: attributed.processResourceId,
        requestId: input.requestId,
        scope: input.scope,
        signal: input.signal
      })
      return await this.#handle(request, common)
    } catch (error) {
      return encodeV86FuseErrorV1(request, errno(error))
    }
  }

  #releaseWithoutProcess(request) {
    const handleId = fuseBodyViewV1(request, 8).getBigUint64(0, true)
    const handle = this.#handles.get(handleId)
    const expectedKind = request.opcode === V86_FUSE_OPERATIONS_V1.release ? 'file' : 'directory'
    if (handle?.kind !== expectedKind || handle.nodeId !== request.nodeId) {
      return encodeV86FuseErrorV1(request, 9)
    }
    if (!this.#retireHandle(handleId, handle)) return encodeV86FuseErrorV1(request, 9)
    return encodeV86FuseResultV1(request, new Uint8Array())
  }

  async #handle(request, common) {
    const operation = V86_FUSE_OPERATIONS_V1
    if (request.opcode === operation.init) return encodeV86FuseInitV1(request)
    if (
      typeof common.executableId !== 'string' || typeof common.processResourceId !== 'string' ||
      common.processId === 0
    ) return encodeV86FuseErrorV1(request, 13)
    const path = this.#inodes.get(request.nodeId)
    if (path == null) return encodeV86FuseErrorV1(request, 2)
    if (request.opcode === operation.getattr) {
      const value = await this.#dispatch({ ...common, operation: 'getattr', path })
      const result = metadata(value)
      if (this.#inodes.get(request.nodeId) === path) this.#inodeKinds.set(request.nodeId, result.kind)
      return encodeV86FuseAttrV1(request, request.nodeId, result)
    }
    if (request.opcode === operation.access) {
      const { mask } = decodeV86FuseAccessV1(request)
      const result = await this.#dispatch({ ...common, operation: 'access', path, mask })
      if (result != null) throw Object.assign(new TypeError('Invalid FUSE access result'), { errno: 5 })
      return encodeV86FuseResultV1(request, new Uint8Array())
    }
    if (request.opcode === operation.setattr) {
      const change = decodeV86FuseSetattrV1(request)
      const handle = change.handleId == null ? undefined : this.#handles.get(change.handleId)
      if (
        change.handleId != null &&
        (handle == null || handle.path !== path || handle.nodeId !== request.nodeId ||
          (change.kind !== 'mode' && handle.kind !== 'file'))
      ) {
        return encodeV86FuseErrorV1(request, 9)
      }
      if (change.modeKind != null && handle != null && change.modeKind !== handle.kind) {
        return encodeV86FuseErrorV1(request, 22)
      }
      if (
        change.modeKind != null && handle == null &&
        change.modeKind !== this.#inodeKinds.get(request.nodeId)
      ) return encodeV86FuseErrorV1(request, 22)
      const value = await this.#dispatch({
        ...common,
        operation: 'setattr',
        path,
        ...(handle == null ? {} : { handle: handle.token }),
        ...(change.kind === 'mode'
          ? {
            mode: change.mode,
            ...(change.modeKind == null ? {} : { expectedKind: change.modeKind }),
            ...(handle == null ? {} : { handleKind: handle.kind })
          }
          : change.kind === 'size'
          ? { size: change.size }
          : { atime: change.atime, mtime: change.mtime })
      })
      const result = metadata(value)
      if (
        change.kind === 'mode' &&
        ((result.mode & 0o777) !== change.mode ||
          (change.modeKind != null && result.kind !== change.modeKind))
      ) throw Object.assign(new TypeError('Invalid FUSE chmod readback'), { errno: 5 })
      return encodeV86FuseAttrV1(request, request.nodeId, result)
    }
    if (request.opcode === operation.lookup) {
      const childPath = `${path}/${fuseNameV1(request)}`
      const value = metadata(await this.#dispatch({ ...common, operation: 'lookup', path: childPath }))
      return encodeV86FuseEntryV1(request, this.#inode(childPath, value.kind), value)
    }
    if (request.opcode === operation.open || request.opcode === operation.create) {
      return this.#open(request, common, path)
    }
    if (request.opcode === operation.mkdir) {
      fuseBodyViewV1(request, 9)
      const childPath = `${path}/${fuseNameV1(request, 8)}`
      const inode = this.#reserveInode(childPath)
      try {
        const value = metadata(await this.#dispatch({ ...common, operation: 'mkdir', path: childPath }))
        const nodeId = inode.commit()
        this.#inodeKinds.set(nodeId, value.kind)
        return encodeV86FuseEntryV1(request, nodeId, value)
      } finally {
        inode.release()
      }
    }
    if (request.opcode === operation.opendir) {
      this.#reserveHandle()
      let token
      try {
        fuseBodyViewV1(request, 8)
        const opened = await this.#dispatch({ ...common, operation: 'opendir', path })
        token = opened?.handle
        const values = opened?.entries
        if (
          opened == null || typeof opened !== 'object' ||
          Object.keys(opened).length !== 2 ||
          typeof token !== 'string' || token.length === 0 || token.length > 256 ||
          !Array.isArray(values) || values.length > 1024 ||
          values.some(value =>
            value == null || typeof value !== 'object' || typeof value.name !== 'string' ||
            !['directory', 'file', 'symlink'].includes(value.kind)
          )
        ) throw Object.assign(new TypeError('Invalid FUSE directory'), { errno: 5 })
        if (this.#closed) throw Object.assign(new Error('Closed FUSE environment'), { errno: 9 })
        const bytes = values.reduce((total, value) => total + value.name.length * 3 + 128, 256)
        if (this.#directoryEntries + values.length + 2 > 8192 || this.#directoryBytes + bytes > 2 * 1024 * 1024) {
          throw Object.assign(new Error('FUSE directory snapshot limit'), { errno: 28 })
        }
        const entries = Object.freeze([
          Object.freeze({ kind: 'directory', name: '.', path }),
          Object.freeze({ kind: 'directory', name: '..', path: this.#parent(path) }),
          ...values.map(value =>
            Object.freeze({
              kind: value.kind,
              name: value.name,
              path: `${path}/${value.name}`
            })
          )
        ])
        this.#directoryEntries += entries.length
        this.#directoryBytes += bytes
        const handleId = this.#handleId(path, token, 'directory', bytes, entries, request.nodeId)
        token = undefined
        return encodeV86FuseOpenV1(request, handleId)
      } finally {
        if (typeof token === 'string') this.#release(token)
        this.#pendingHandles--
      }
    }
    if (request.opcode === operation.readdir) {
      const view = fuseBodyViewV1(request, 40)
      const handle = this.#handles.get(view.getBigUint64(0, true))
      if (handle?.kind !== 'directory') return encodeV86FuseErrorV1(request, 9)
      const offset = Number(view.getBigUint64(8, true))
      return encodeV86FuseDirectoryV1(
        request,
        handle.entries,
        offset,
        view.getUint32(16, true),
        (value, kind) => this.#inode(value, kind)
      )
    }
    if (request.opcode === operation.read) {
      const view = fuseBodyViewV1(request, 40)
      const handle = this.#handles.get(view.getBigUint64(0, true))
      if (handle?.kind !== 'file') return encodeV86FuseErrorV1(request, 9)
      const offset = safeOffset(view)
      const size = view.getUint32(16, true)
      if (size > 64 * 1024) return encodeV86FuseErrorV1(request, 22)
      const result = await this.#dispatch({
        ...common,
        offset,
        operation: 'read',
        handle: handle.token,
        path: handle.path,
        size
      })
      if (!(result instanceof Uint8Array) || result.byteLength > size) {
        throw Object.assign(new TypeError('Invalid FUSE read'), { errno: 5 })
      }
      return encodeV86FuseResultV1(request, result)
    }
    if (request.opcode === operation.write) return await this.#write(request, common)
    if (request.opcode === operation.release || request.opcode === operation.releasedir) {
      const handleId = fuseBodyViewV1(request, 8).getBigUint64(0, true)
      const handle = this.#handles.get(handleId)
      if (handle == null) return encodeV86FuseErrorV1(request, 9)
      if (request.opcode === operation.release && handle.kind === 'file') {
        try {
          await this.#dispatch({ ...common, handle: handle.token, operation: 'release', path: handle.path })
        } finally {
          this.#retireHandle(handleId, handle)
        }
      } else if (request.opcode !== operation.releasedir || handle.kind !== 'directory') {
        return encodeV86FuseErrorV1(request, 9)
      }
      if (handle.kind === 'directory') {
        try {
          await this.#dispatch({ ...common, handle: handle.token, operation: 'releasedir', path: handle.path })
        } finally {
          this.#retireHandle(handleId, handle)
        }
      }
      return encodeV86FuseResultV1(request, new Uint8Array())
    }
    if (request.opcode === operation.unlink || request.opcode === operation.rmdir) {
      const childPath = `${path}/${fuseNameV1(request)}`
      await this.#dispatch({
        ...common,
        operation: request.opcode === operation.rmdir ? 'rmdir' : 'unlink',
        path: childPath
      })
      this.#forgetPath(childPath)
      return encodeV86FuseResultV1(request, new Uint8Array())
    }
    if (request.opcode === operation.rename) {
      const view = fuseBodyViewV1(request, 10)
      const destinationParent = this.#inodes.get(view.getBigUint64(0, true))
      if (destinationParent == null) return encodeV86FuseErrorV1(request, 2)
      const [fromName, toName] = fuseNamesV1(request, 8, 2)
      const fromPath = `${path}/${fromName}`
      const toPath = `${destinationParent}/${toName}`
      await this.#dispatch({ ...common, operation: 'rename', path: fromPath, toPath })
      if (fromPath !== toPath) this.#forgetPath(toPath)
      this.#renamePath(fromPath, toPath)
      return encodeV86FuseResultV1(request, new Uint8Array())
    }
    if (request.opcode === operation.statfs) {
      await this.#dispatch({ ...common, operation: 'getattr', path })
      return encodeV86FuseStatfsV1(request)
    }
    if (request.opcode === operation.fsync || request.opcode === operation.fsyncdir) {
      const { handleId, datasync } = decodeV86FuseFsyncV1(request)
      const handle = this.#handles.get(handleId)
      const file = request.opcode === operation.fsync
      if (handle?.kind !== (file ? 'file' : 'directory') || handle.path !== path) {
        return encodeV86FuseErrorV1(request, 9)
      }
      const result = await this.#dispatch({
        ...common,
        operation: file ? 'fsync' : 'fsyncdir',
        path,
        datasync,
        handle: handle.token
      })
      if (result != null) throw Object.assign(new TypeError('Invalid FUSE sync result'), { errno: 5 })
      return encodeV86FuseResultV1(request, new Uint8Array())
    }
    if (request.opcode === operation.flush) {
      if (request.body.byteLength !== 24) return encodeV86FuseErrorV1(request, 5)
      const view = fuseBodyViewV1(request, 24)
      if (view.getUint32(8, true) !== 0 || view.getUint32(12, true) !== 0) {
        return encodeV86FuseErrorV1(request, 5)
      }
      const handle = this.#handles.get(view.getBigUint64(0, true))
      if (handle?.kind !== 'file' || handle.path !== path) return encodeV86FuseErrorV1(request, 9)
      // Every WRITE waits for its Provider result; FLUSH acknowledges that state, not durability.
      return encodeV86FuseResultV1(request, new Uint8Array())
    }
    return encodeV86FuseErrorV1(request, 38)
  }

  #forgetPath(path) {
    for (const [value, id] of this.#inodeIds) {
      if (value === path || value.startsWith(`${path}/`)) {
        this.#inodeIds.delete(value)
        this.#inodes.delete(id)
        this.#inodeKinds.delete(id)
      }
    }
  }

  #retireHandle(id, handle) {
    const current = this.#handles.get(id)
    if (current == null || current.kind !== handle.kind || current.token !== handle.token) return false
    this.#handles.delete(id)
    if (current.kind === 'directory') {
      this.#directoryEntries -= current.entries.length
      this.#directoryBytes -= current.bytes
    }
    this.#release(current.token)
    return true
  }

  #reserveHandle() {
    if (this.#closed || this.#handles.size + this.#pendingHandles >= 64) {
      throw Object.assign(new Error('FUSE handle limit'), { errno: 24 })
    }
    this.#pendingHandles++
  }

  async #open(request, common, path) {
    this.#reserveHandle()
    let token
    let inode
    try {
      const create = request.opcode === V86_FUSE_OPERATIONS_V1.create
      const view = fuseBodyViewV1(request, create ? 17 : 8)
      const target = create ? `${path}/${fuseNameV1(request, 16)}` : path
      inode = create ? this.#reserveInode(target) : undefined
      const opened = await this.#dispatch({
        ...common,
        flags: view.getUint32(0, true),
        ...(create ? { mode: view.getUint32(4, true) } : {}),
        operation: create ? 'create' : 'open',
        path: target
      })
      token = create ? opened?.handle : opened
      if (typeof token !== 'string' || token.length === 0 || token.length > 256) {
        throw Object.assign(new Error('Invalid FUSE file handle'), { errno: 5 })
      }
      if (this.#closed) throw Object.assign(new Error('Closed FUSE environment'), { errno: 9 })
      const value = create ? metadata(opened) : undefined
      const nodeId = create ? inode.commit() : request.nodeId
      if (create) this.#inodeKinds.set(nodeId, value.kind)
      const handleId = this.#handleId(target, token, 'file', 0, undefined, nodeId)
      token = undefined
      return create
        ? encodeV86FuseEntryV1(request, nodeId, value, handleId)
        : encodeV86FuseOpenV1(request, handleId)
    } finally {
      inode?.release()
      if (typeof token === 'string') this.#release(token)
      this.#pendingHandles--
    }
  }

  #handleId(path, token, kind = 'file', bytes = 0, entries, nodeId) {
    const id = this.#nextHandle++
    this.#handles.set(
      id,
      Object.freeze({
        kind,
        path,
        token,
        bytes,
        nodeId,
        ...(kind === 'directory' ? { entries } : {})
      })
    )
    return id
  }

  #inode(path, kind) {
    const existing = this.#inodeIds.get(path)
    if (existing != null) {
      if (kind != null) this.#inodeKinds.set(existing, kind)
      return existing
    }
    const inode = this.#reserveInode(path)
    try {
      const nodeId = inode.commit()
      if (kind != null) this.#inodeKinds.set(nodeId, kind)
      return nodeId
    } finally {
      inode.release()
    }
  }

  #reserveInode(path) {
    if (this.#closed) throw Object.assign(new Error('Closed FUSE environment'), { errno: 9 })
    let pending = this.#pendingInodes.get(path)
    if (pending == null) {
      if (!this.#inodeIds.has(path) && this.#inodes.size + this.#pendingInodes.size >= 4096) {
        throw Object.assign(new Error('FUSE inode limit'), { errno: 28 })
      }
      pending = { id: this.#nextInode++, users: 0 }
      this.#pendingInodes.set(path, pending)
    }
    pending.users++
    let active = true
    const release = () => {
      if (!active) return
      active = false
      if (--pending.users === 0 && this.#pendingInodes.get(path) === pending) this.#pendingInodes.delete(path)
    }
    return {
      commit: () => {
        if (this.#closed) throw Object.assign(new Error('Closed FUSE environment'), { errno: 9 })
        const id = this.#inodeIds.get(path) ?? pending.id
        this.#inodeIds.set(path, id)
        this.#inodes.set(id, path)
        release()
        return id
      },
      release
    }
  }

  #parent(path) {
    if (path === '/workspace') return path
    const index = path.lastIndexOf('/')
    return index <= '/workspace'.length ? '/workspace' : path.slice(0, index)
  }

  #renamePath(from, to) {
    const changes = [...this.#inodeIds.entries()].filter(([path]) => path === from || path.startsWith(`${from}/`))
    for (const [path, id] of changes) {
      const target = `${to}${path.slice(from.length)}`
      this.#inodeIds.delete(path)
      this.#inodeIds.set(target, id)
      this.#inodes.set(id, target)
    }
    for (const [id, handle] of this.#handles) {
      if (handle.path !== from && !handle.path.startsWith(`${from}/`)) continue
      this.#handles.set(
        id,
        Object.freeze({
          ...handle,
          path: `${to}${handle.path.slice(from.length)}`
        })
      )
    }
  }

  async #write(request, common) {
    const view = fuseBodyViewV1(request, 40)
    const handle = this.#handles.get(view.getBigUint64(0, true))
    const size = view.getUint32(16, true)
    if (handle?.kind !== 'file') return encodeV86FuseErrorV1(request, 9)
    if (size > 64 * 1024 || request.body.byteLength !== 40 + size) return encodeV86FuseErrorV1(request, 22)
    const offset = safeOffset(view)
    const written = await this.#dispatch({
      ...common,
      bytes: request.body.slice(40),
      handle: handle.token,
      offset,
      operation: 'write',
      path: handle.path
    })
    if (!Number.isInteger(written) || written < 0 || written > size) {
      throw Object.assign(new TypeError('Invalid FUSE write'), { errno: 5 })
    }
    return encodeV86FuseWriteV1(request, written)
  }
}

/** Keeps kernel inode and handle identities isolated to one v86 environment. */
export class V86FuseBridgeV1 {
  #dispatch
  #release
  #environments = new Map()

  constructor(dispatch, { releaseFileHandle } = {}) {
    if (typeof dispatch !== 'function') throw new TypeError('Invalid v86 FUSE dispatch')
    this.#dispatch = dispatch
    this.#release = token => {
      try {
        releaseFileHandle?.(token)
      } catch { /* Trusted resource cleanup remains best-effort after generation close. */ }
    }
  }

  handle(input) {
    const environmentId = input?.environmentId ?? 'legacy-test-environment'
    if (typeof environmentId !== 'string' || environmentId.length === 0 || environmentId.length > 256) {
      throw new TypeError('Invalid v86 FUSE environment')
    }
    let environment = this.#environments.get(environmentId)
    if (environment == null) {
      if (this.#environments.size >= 64) throw new Error('FUSE environment limit')
      environment = new V86FuseEnvironmentBridgeV1(this.#dispatch, this.#release)
      this.#environments.set(environmentId, environment)
    }
    return environment.handle(input)
  }

  releaseEnvironment(environmentId) {
    if (typeof environmentId !== 'string') return false
    this.#environments.get(environmentId)?.close()
    return this.#environments.delete(environmentId)
  }
}
