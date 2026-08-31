;(() => {
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
    target.setUint32(68, 1000, true)
    target.setUint32(72, 1000, true)
    target.setUint32(80, 4096, true)
    return output
  }
  const init = unique => {
    const body = new Uint8Array(64)
    const target = view(body)
    target.setUint32(0, 7, true)
    target.setUint32(4, 39, true)
    target.setUint32(12, 1 << 3, true)
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
    const source = input.slice(0, -1)
    if (source.includes(0)) throw new Error('Invalid FUSE name')
    const output = new TextDecoder('utf-8', { fatal: true }).decode(source)
    if (output === '' || output === '.' || output === '..' || output.includes('/') || output.length > 255) {
      throw new Error('Invalid FUSE name')
    }
    return output
  }
  const names = (request, offset, count) => {
    const input = request.body.slice(offset)
    const output = []
    let start = 0
    for (let index = 0; index < input.byteLength; index += 1) {
      if (input[index] !== 0) continue
      output.push(name({ ...request, body: input.slice(start, index + 1) }))
      start = index + 1
    }
    if (start !== input.byteLength || output.length !== count) throw new Error('Invalid FUSE names')
    return output
  }
  const align8 = value => (value + 7) & ~7
  const directory = (request, entries, offset, maximum, inode) => {
    const encoder = new TextEncoder()
    const parts = entries.map((item, index) => {
      const encoded = encoder.encode(item.name)
      const body = new Uint8Array(align8(24 + encoded.byteLength))
      const target = view(body)
      target.setBigUint64(0, inode(item.path), true)
      target.setBigUint64(8, BigInt(index + 1), true)
      target.setUint32(16, encoded.byteLength, true)
      target.setUint32(20, item.kind === 'directory' ? 4 : item.kind === 'symlink' ? 10 : 8, true)
      body.set(encoded, 24)
      return body
    })
    const selected = []
    let length = 0
    for (let index = offset; index < parts.length; index += 1) {
      if (length + parts[index].byteLength > maximum) break
      selected.push(parts[index])
      length += parts[index].byteLength
    }
    const body = new Uint8Array(length)
    let cursor = 0
    for (const part of selected) {
      body.set(part, cursor)
      cursor += part.byteLength
    }
    return response(request.unique, 0, body)
  }
  const statfs = request => {
    const body = new Uint8Array(80)
    const target = view(body)
    target.setBigUint64(0, 1_048_576n, true)
    target.setBigUint64(8, 1_048_576n, true)
    target.setBigUint64(16, 1_048_576n, true)
    target.setBigUint64(24, 1_000_000n, true)
    target.setBigUint64(32, 1_000_000n, true)
    target.setUint32(40, 4096, true)
    target.setUint32(44, 255, true)
    target.setUint32(48, 4096, true)
    return response(request.unique, 0, body)
  }

  globalThis.__holoV86FuseSupport = Object.freeze({
    attribute,
    checkedMetadata: value => {
      if (
        value == null || typeof value !== 'object' ||
        !['directory', 'file'].includes(value.kind) ||
        !Number.isSafeInteger(value.size) || value.size < 0
      ) throw Object.assign(new Error('Invalid FUSE metadata'), { errno: 5 })
      return value
    },
    directory,
    entry,
    init,
    name,
    names,
    parse,
    record: (events, frame, request, operation, path) =>
      events.push(Object.freeze({
        linuxPid: request.pid,
        operation,
        path,
        processId: frame.processId
      })),
    response,
    statfs,
    view
  })
})()
