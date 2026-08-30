;(() => {
  const {
    attribute,
    checkedMetadata,
    directory,
    entry,
    init,
    name,
    names,
    parse,
    record,
    response,
    statfs,
    view
  } = globalThis.__holoV86FuseSupport
  globalThis.__holoCreateV86FuseBridge = dispatch => {
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
    const invoke = typeof dispatch === 'function' ? dispatch : null
    const events = []
    const inode = path => {
      let id = inodeIds.get(path)
      if (id != null) return id
      id = nextInode++
      inodeIds.set(path, id)
      inodes.set(id, path)
      return id
    }
    const handleId = (path, token = path, kind = 'file', attribution = null) => {
      const id = nextHandle++
      const owner = attribution == null
        ? null
        : Object.freeze({ processId: attribution.processId, source: attribution.source ?? null })
      handles.set(id, Object.freeze({ attribution: owner, kind, path, token }))
      return id
    }
    const metadata = path => {
      const value = files.get(path)
      if (value == null) return null
      return { kind: 'file', size: value.byteLength }
    }
    const forgetPath = path => {
      for (const [value, id] of inodeIds) {
        if (value === path || value.startsWith(`${path}/`)) {
          inodeIds.delete(value)
          inodes.delete(id)
        }
      }
    }
    const parentPath = path => {
      if (path === '/workspace') return path
      const index = path.lastIndexOf('/')
      return index <= '/workspace'.length ? '/workspace' : path.slice(0, index)
    }
    const renamePath = (from, to) => {
      for (const [path, id] of [...inodeIds]) {
        if (path !== from && !path.startsWith(`${from}/`)) continue
        const target = `${to}${path.slice(from.length)}`
        inodeIds.delete(path)
        inodeIds.set(target, id)
        inodes.set(id, target)
      }
      for (const [id, item] of handles) {
        if (item.path !== from && !item.path.startsWith(`${from}/`)) continue
        handles.set(id, Object.freeze({ ...item, path: `${to}${item.path.slice(from.length)}` }))
      }
    }
    const handle = async (payload, frame) => {
      const request = parse(payload)
      if (request.opcode === 26) return init(request.unique)
      const release = request.opcode === 18 || request.opcode === 29
      if (!Number.isInteger(frame.processId) || !release && (frame.processId === 0 || request.pid === 0)) {
        return response(request.unique, 13)
      }
      const call = (input, attribution = frame) => invoke({ ...input, linuxPid: request.pid }, attribution)
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
        const source = invoke == null ? metadata(path) : await call({ operation: 'lookup', path })
        const value = source == null ? null : checkedMetadata(source)
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
          view(body).setBigUint64(0, handleId(parent, token, 'file', frame), true)
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
        return entry(
          request,
          inode(path),
          created.kind,
          created.size,
          handleId(path, created.handle, 'file', frame)
        )
      }
      if (request.opcode === 9) {
        const path = `${parent}/${name(request, 8)}`
        record(events, frame, request, 'mkdir', path)
        if (invoke == null) return response(request.unique, 38)
        await call({ operation: 'mkdir', path })
        return entry(request, inode(path), 'directory', 0)
      }
      if (request.opcode === 27) {
        if (invoke == null) return response(request.unique, 38)
        const values = await call({ operation: 'readdir', path: parent })
        if (
          !Array.isArray(values) ||
          values.some(value =>
            value == null || typeof value !== 'object' || typeof value.name !== 'string' ||
            !['directory', 'file', 'symlink'].includes(value.kind)
          )
        ) throw Object.assign(new Error('Invalid FUSE directory'), { errno: 5 })
        const entries = [
          { kind: 'directory', name: '.', path: parent },
          { kind: 'directory', name: '..', path: parentPath(parent) },
          ...values.map(value => ({ kind: value.kind, name: value.name, path: `${parent}/${value.name}` }))
        ]
        return (() => {
          const body = new Uint8Array(16)
          view(body).setBigUint64(0, handleId(parent, entries, 'directory', frame), true)
          return response(request.unique, 0, body)
        })()
      }
      if (request.opcode === 28) {
        const target = view(request.body)
        const item = handles.get(target.getBigUint64(0, true))
        if (item?.kind !== 'directory') return response(request.unique, 9)
        return directory(
          request,
          item.token,
          Number(target.getBigUint64(8, true)),
          target.getUint32(16, true),
          inode
        )
      }
      if (request.opcode === 15) {
        const target = view(request.body)
        const item = handles.get(target.getBigUint64(0, true))
        if (item?.kind !== 'file') return response(request.unique, 9)
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
          }, item.attribution)
        if (!(output instanceof Uint8Array)) throw Object.assign(new Error('Invalid FUSE read'), { errno: 5 })
        return response(request.unique, 0, output)
      }
      if (request.opcode === 16) {
        const target = view(request.body)
        const item = handles.get(target.getBigUint64(0, true))
        const size = target.getUint32(16, true)
        if (item?.kind !== 'file' || request.body.byteLength !== 40 + size) return response(request.unique, 9)
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
          }, item.attribution)
          if (!Number.isInteger(written) || written < 0 || written > size) {
            throw Object.assign(new Error('Invalid FUSE write'), { errno: 5 })
          }
        }
        record(events, frame, request, 'write', item.path)
        const body = new Uint8Array(8)
        view(body).setUint32(0, written, true)
        return response(request.unique, 0, body)
      }
      if (request.opcode === 18 || request.opcode === 29) {
        const id = view(request.body).getBigUint64(0, true)
        const item = handles.get(id)
        if (item == null) return response(request.unique, 9)
        if (request.opcode === 18 && item.kind !== 'file' || request.opcode === 29 && item.kind !== 'directory') {
          return response(request.unique, 9)
        }
        if (invoke != null && item.kind === 'file') {
          if (!Number.isInteger(item.attribution?.processId) || item.attribution.processId === 0) {
            return response(request.unique, 13)
          }
          await call({ handle: item.token, operation: 'release', path: item.path }, item.attribution)
        }
        handles.delete(id)
        record(events, frame, request, 'release', item.path)
        return response(request.unique, 0)
      }
      if (request.opcode === 10 || request.opcode === 11) {
        const path = `${parent}/${name(request)}`
        if (invoke == null) return response(request.unique, 38)
        await call({ operation: request.opcode === 11 ? 'rmdir' : 'unlink', path })
        forgetPath(path)
        return response(request.unique, 0)
      }
      if (request.opcode === 12) {
        const destinationParent = inodes.get(view(request.body).getBigUint64(0, true))
        if (destinationParent == null) return response(request.unique, 2)
        const [fromName, toName] = names(request, 8, 2)
        const fromPath = `${parent}/${fromName}`
        const toPath = `${destinationParent}/${toName}`
        if (invoke == null) return response(request.unique, 38)
        await call({ operation: 'rename', path: fromPath, toPath })
        renamePath(fromPath, toPath)
        return response(request.unique, 0)
      }
      if (request.opcode === 17) return statfs(request)
      if ([20, 25, 30, 34].includes(request.opcode)) return response(request.unique, 0)
      return response(request.unique, 38)
    }
    return Object.freeze({
      events,
      failure: (payload, errno = 5) => response(parse(payload).unique, errno),
      handle,
      readFile: path => Uint8Array.from(files.get(path) ?? [])
    })
  }
})()
