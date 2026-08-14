import {
  V86_FUSE_OPERATIONS_V1,
  decodeV86FuseRequestV1,
  encodeV86FuseAttrV1,
  encodeV86FuseEntryV1,
  encodeV86FuseErrorV1,
  encodeV86FuseInitV1,
  encodeV86FuseOpenV1,
  encodeV86FuseResultV1,
  encodeV86FuseWriteV1,
  fuseBodyViewV1,
  fuseNameV1
} from './capability-process-v86-fuse-protocol.mjs'

const errno = error => {
  const value = Number(error?.errno)
  return Number.isInteger(value) && value > 0 && value <= 4095 ? value : 5
}

const metadata = value => {
  if (
    value == null || typeof value !== 'object' ||
    !['directory', 'file'].includes(value.kind) ||
    !Number.isSafeInteger(value.size) || value.size < 0
  ) throw Object.assign(new TypeError('Invalid v86 FUSE metadata'), { errno: 5 })
  return Object.freeze({ kind: value.kind, size: value.size })
}

export class V86FuseBridgeV1 {
  #dispatch
  #handles = new Map()
  #inodes = new Map([[1n, '/workspace']])
  #inodeIds = new Map([['/workspace', 1n]])
  #nextHandle = 1n
  #nextInode = 2n

  constructor(dispatch) {
    if (typeof dispatch !== 'function') throw new TypeError('Invalid v86 FUSE dispatch')
    this.#dispatch = dispatch
  }

  async handle(input) {
    const request = decodeV86FuseRequestV1(input.payload)
    const common = Object.freeze({
      environmentId: input.environmentId,
      executableId: input.executableId,
      generation: input.generation,
      linuxPid: request.pid,
      policy: input.policy,
      processId: input.processId,
      processResourceId: input.processResourceId,
      requestId: input.requestId,
      scope: input.scope,
      signal: input.signal
    })
    try {
      return await this.#handle(request, common)
    } catch (error) {
      return encodeV86FuseErrorV1(request, errno(error))
    }
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
      const value = request.nodeId === 1n
        ? { kind: 'directory', size: 0 }
        : await this.#dispatch({ ...common, operation: 'getattr', path })
      return encodeV86FuseAttrV1(request, request.nodeId, metadata(value))
    }
    if (request.opcode === operation.lookup) {
      const childPath = `${path}/${fuseNameV1(request)}`
      const value = metadata(await this.#dispatch({ ...common, operation: 'lookup', path: childPath }))
      return encodeV86FuseEntryV1(request, this.#inode(childPath), value)
    }
    if (request.opcode === operation.open) {
      const view = fuseBodyViewV1(request, 8)
      const token = await this.#dispatch({
        ...common,
        flags: view.getUint32(0, true),
        operation: 'open',
        path
      })
      return encodeV86FuseOpenV1(request, this.#handleId(path, token))
    }
    if (request.opcode === operation.create) {
      const view = fuseBodyViewV1(request, 17)
      const childPath = `${path}/${fuseNameV1(request, 16)}`
      const created = await this.#dispatch({
        ...common,
        flags: view.getUint32(0, true),
        mode: view.getUint32(4, true),
        operation: 'create',
        path: childPath
      })
      const value = metadata(created)
      return encodeV86FuseEntryV1(
        request,
        this.#inode(childPath),
        value,
        this.#handleId(childPath, created.handle)
      )
    }
    if (request.opcode === operation.read) {
      const view = fuseBodyViewV1(request, 40)
      const handle = this.#handles.get(view.getBigUint64(0, true))
      if (handle == null) return encodeV86FuseErrorV1(request, 9)
      const result = await this.#dispatch({
        ...common,
        offset: Number(view.getBigUint64(8, true)),
        operation: 'read',
        handle: handle.token,
        path: handle.path,
        size: view.getUint32(16, true)
      })
      if (!(result instanceof Uint8Array)) throw Object.assign(new TypeError('Invalid FUSE read'), { errno: 5 })
      return encodeV86FuseResultV1(request, result)
    }
    if (request.opcode === operation.write) return await this.#write(request, common)
    if (request.opcode === operation.release) {
      const handleId = fuseBodyViewV1(request, 8).getBigUint64(0, true)
      const handle = this.#handles.get(handleId)
      if (handle == null) return encodeV86FuseErrorV1(request, 9)
      await this.#dispatch({ ...common, handle: handle.token, operation: 'release', path: handle.path })
      this.#handles.delete(handleId)
      return encodeV86FuseResultV1(request, new Uint8Array())
    }
    if (request.opcode === operation.access || request.opcode === operation.flush) {
      return encodeV86FuseResultV1(request, new Uint8Array())
    }
    return encodeV86FuseErrorV1(request, 38)
  }

  #handleId(path, token) {
    const id = this.#nextHandle++
    this.#handles.set(id, Object.freeze({ path, token }))
    return id
  }

  #inode(path) {
    let id = this.#inodeIds.get(path)
    if (id != null) return id
    id = this.#nextInode++
    this.#inodeIds.set(path, id)
    this.#inodes.set(id, path)
    return id
  }

  async #write(request, common) {
    const view = fuseBodyViewV1(request, 40)
    const handle = this.#handles.get(view.getBigUint64(0, true))
    const size = view.getUint32(16, true)
    if (handle == null || request.body.byteLength !== 40 + size) return encodeV86FuseErrorV1(request, 9)
    const written = await this.#dispatch({
      ...common,
      bytes: request.body.slice(40),
      handle: handle.token,
      offset: Number(view.getBigUint64(8, true)),
      operation: 'write',
      path: handle.path
    })
    if (!Number.isInteger(written) || written < 0 || written > size) {
      throw Object.assign(new TypeError('Invalid FUSE write'), { errno: 5 })
    }
    return encodeV86FuseWriteV1(request, written)
  }
}
