;(() => {
  const FUSE_ATOMIC_O_TRUNC = 1 << 3
  const files = new Map([[
    '/workspace/input.txt',
    new Uint8Array([
      72,
      79,
      83,
      84,
      95,
      84,
      79,
      95,
      71,
      85,
      69,
      83,
      84
    ])
  ]])
  const handles = new Map()
  const inodes = new Map([[1n, '/workspace']])
  const inodeIds = new Map([['/workspace', 1n]])
  let nextHandle = 1n
  let nextInode = 2n

  const view = value => new DataView(value.buffer, value.byteOffset, value.byteLength)
  const response = (unique, error, body = new Uint8Array()) => {
    const output = new Uint8Array(16 + body.byteLength)
    const target = view(output)
    target.setUint32(0, output.byteLength, true)
    target.setInt32(4, error === 0 ? 0 : -Math.abs(error), true)
    target.setBigUint64(8, unique, true)
    output.set(body, 16)
    return output
  }
  const attr = (nodeId, kind, size) => {
    const output = new Uint8Array(88)
    const target = view(output)
    const length = BigInt(kind === 'directory' ? 0 : size)
    target.setBigUint64(0, nodeId, true)
    target.setBigUint64(8, length, true)
    target.setBigUint64(16, (length + 511n) / 512n, true)
    target.setUint32(60, kind === 'directory' ? 0o040755 : 0o100644, true)
    target.setUint32(64, kind === 'directory' ? 2 : 1, true)
    target.setUint32(80, 4096, true)
    return output
  }
  const init = unique => {
    const body = new Uint8Array(64)
    const target = view(body)
    target.setUint32(0, 7, true)
    target.setUint32(4, 39, true)
    target.setUint32(12, FUSE_ATOMIC_O_TRUNC, true)
    target.setUint16(16, 16, true)
    target.setUint16(18, 12, true)
    target.setUint32(20, 64 * 1024, true)
    target.setUint32(24, 1, true)
    target.setUint16(28, 16, true)
    return response(unique, 0, body)
  }
  const attribute = (request, nodeId, kind, size) => {
    const body = new Uint8Array(104)
    body.set(attr(nodeId, kind, size), 16)
    return response(request.unique, 0, body)
  }
  const entry = (request, nodeId, kind, size, handleId) => {
    const body = new Uint8Array(handleId == null ? 128 : 144)
    const target = view(body)
    target.setBigUint64(0, nodeId, true)
    target.setBigUint64(8, 1n, true)
    body.set(attr(nodeId, kind, size), 40)
    if (handleId != null) target.setBigUint64(128, handleId, true)
    return response(request.unique, 0, body)
  }
  const parse = payload => {
    if (!(payload instanceof Uint8Array) || payload.byteLength < 40) throw new Error('Invalid FUSE request')
    const target = view(payload)
    if (target.getUint32(0, true) !== payload.byteLength) throw new Error('Invalid FUSE length')
    return {
      body: payload.slice(40),
      nodeId: target.getBigUint64(16, true),
      opcode: target.getUint32(4, true),
      pid: target.getUint32(32, true),
      unique: target.getBigUint64(8, true)
    }
  }
  const name = (request, offset = 0) => {
    const input = request.body.slice(offset)
    if (input.byteLength < 2 || input.at(-1) !== 0) throw new Error('Invalid FUSE name')
    let output = ''
    for (const byte of input.slice(0, -1)) {
      if (byte === 0 || byte > 0x7F) throw new Error('Invalid FUSE name')
      output += String.fromCharCode(byte)
    }
    if (output === '' || output === '.' || output === '..' || output.includes('/')) throw new Error('Invalid FUSE name')
    return output
  }
  const inode = path => {
    let id = inodeIds.get(path)
    if (id != null) return id
    id = nextInode++
    inodeIds.set(path, id)
    inodes.set(id, path)
    return id
  }
  const handleId = (path, token = path) => {
    const id = nextHandle++
    handles.set(id, Object.freeze({ path, token }))
    return id
  }
  const metadata = path => {
    const value = files.get(path)
    if (value == null) return null
    return { kind: 'file', size: value.byteLength }
  }
  const record = (events, frame, request, operation, path) =>
    events.push(Object.freeze({
      linuxPid: request.pid,
      operation,
      path,
      processId: frame.processId
    }))

  const checkedMetadata = value => {
    if (
      value == null || typeof value !== 'object' ||
      !['directory', 'file'].includes(value.kind) ||
      !Number.isSafeInteger(value.size) || value.size < 0
    ) throw Object.assign(new Error('Invalid FUSE metadata'), { errno: 5 })
    return value
  }

  globalThis.__holoCreateV86FuseProbe = dispatch => {
    const invoke = typeof dispatch === 'function' ? dispatch : null
    const events = []
    const handle = async (payload, frame) => {
      const request = parse(payload)
      if (request.opcode === 26) return init(request.unique)
      if (!Number.isInteger(frame.processId) || frame.processId === 0 || request.pid === 0) {
        return response(request.unique, 13)
      }
      const call = input => invoke({ ...input, linuxPid: request.pid, processId: frame.processId })
      const parent = inodes.get(request.nodeId)
      if (parent == null) return response(request.unique, 2)
      if (request.opcode === 3) {
        record(events, frame, request, 'getattr', parent)
        const value = request.nodeId === 1n
          ? { kind: 'directory', size: 0 }
          : invoke == null
          ? metadata(parent)
          : checkedMetadata(await call({ operation: 'getattr', path: parent }))
        return value == null ? response(request.unique, 2) : attribute(request, request.nodeId, value.kind, value.size)
      }
      if (request.opcode === 1) {
        const path = `${parent}/${name(request)}`
        record(events, frame, request, 'lookup', path)
        const value = invoke == null
          ? metadata(path)
          : checkedMetadata(await call({ operation: 'lookup', path }))
        return value == null ? response(request.unique, 2) : entry(request, inode(path), value.kind, value.size)
      }
      if (request.opcode === 14) {
        record(events, frame, request, 'open', parent)
        const token = invoke == null
          ? metadata(parent) == null ? null : parent
          : await call({
            flags: view(request.body).getUint32(0, true),
            operation: 'open',
            path: parent
          })
        return token == null ? response(request.unique, 2) : (() => {
          const body = new Uint8Array(16)
          view(body).setBigUint64(0, handleId(parent, token), true)
          return response(request.unique, 0, body)
        })()
      }
      if (request.opcode === 35) {
        const path = `${parent}/${name(request, 16)}`
        record(events, frame, request, 'create', path)
        if (invoke == null) {
          files.set(path, new Uint8Array())
          return entry(request, inode(path), 'file', 0, handleId(path))
        }
        const target = view(request.body)
        const created = checkedMetadata(
          await call({
            flags: target.getUint32(0, true),
            mode: target.getUint32(4, true),
            operation: 'create',
            path
          })
        )
        if (typeof created.handle !== 'string') throw Object.assign(new Error('Invalid FUSE handle'), { errno: 5 })
        return entry(request, inode(path), created.kind, created.size, handleId(path, created.handle))
      }
      if (request.opcode === 15) {
        const target = view(request.body)
        const item = handles.get(target.getBigUint64(0, true))
        if (item == null) return response(request.unique, 9)
        const offset = Number(target.getBigUint64(8, true))
        const size = target.getUint32(16, true)
        record(events, frame, request, 'read', item.path)
        const output = invoke == null
          ? files.get(item.path).slice(offset, offset + size)
          : await call({
            handle: item.token,
            offset,
            operation: 'read',
            path: item.path,
            size
          })
        if (!(output instanceof Uint8Array)) throw Object.assign(new Error('Invalid FUSE read'), { errno: 5 })
        return response(request.unique, 0, output)
      }
      if (request.opcode === 16) {
        const target = view(request.body)
        const item = handles.get(target.getBigUint64(0, true))
        const size = target.getUint32(16, true)
        if (item == null || request.body.byteLength !== 40 + size) return response(request.unique, 9)
        const offset = Number(target.getBigUint64(8, true))
        const input = request.body.slice(40)
        let written = size
        if (invoke == null) {
          const current = files.get(item.path) ?? new Uint8Array()
          const output = new Uint8Array(Math.max(current.byteLength, offset + size))
          output.set(current)
          output.set(input, offset)
          files.set(item.path, output)
        } else {
          written = await call({
            bytes: input,
            handle: item.token,
            offset,
            operation: 'write',
            path: item.path
          })
          if (!Number.isInteger(written) || written < 0 || written > size) {
            throw Object.assign(new Error('Invalid FUSE write'), { errno: 5 })
          }
        }
        record(events, frame, request, 'write', item.path)
        const body = new Uint8Array(8)
        view(body).setUint32(0, written, true)
        return response(request.unique, 0, body)
      }
      if (request.opcode === 18) {
        const id = view(request.body).getBigUint64(0, true)
        const item = handles.get(id)
        if (item == null) return response(request.unique, 9)
        if (invoke != null) await call({ handle: item.token, operation: 'release', path: item.path })
        handles.delete(id)
        record(events, frame, request, 'release', item.path)
        return response(request.unique, 0)
      }
      if (request.opcode === 25 || request.opcode === 34) return response(request.unique, 0)
      return response(request.unique, 38)
    }
    return Object.freeze({
      events,
      handle,
      readFile: path => Uint8Array.from(files.get(path) ?? [])
    })
  }
})()
