const HEADER_BYTES = 40
const FUSE_ATOMIC_O_TRUNC = 1 << 3

export const V86_FUSE_OPERATIONS_V1 = Object.freeze({
  access: 34,
  create: 35,
  flush: 25,
  getattr: 3,
  init: 26,
  lookup: 1,
  mkdir: 9,
  open: 14,
  opendir: 27,
  read: 15,
  readdir: 28,
  release: 18,
  releasedir: 29,
  rename: 12,
  rmdir: 11,
  fsync: 20,
  fsyncdir: 30,
  statfs: 17,
  unlink: 10,
  write: 16
})

const invalid = () => {
  const error = new TypeError('Invalid v86 FUSE frame')
  Object.defineProperty(error, 'errno', { value: 5 })
  throw error
}

const unsigned = (view, offset, bytes) =>
  bytes === 4
    ? view.getUint32(offset, true)
    : view.getBigUint64(offset, true)

export const decodeV86FuseRequestV1 = payload => {
  if (!(payload instanceof Uint8Array) || payload.byteLength < HEADER_BYTES) return invalid()
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  if (view.getUint32(0, true) !== payload.byteLength || view.getBigUint64(8, true) === 0n) return invalid()
  return Object.freeze({
    body: payload.slice(HEADER_BYTES),
    nodeId: unsigned(view, 16, 8),
    opcode: unsigned(view, 4, 4),
    pid: unsigned(view, 32, 4),
    unique: unsigned(view, 8, 8)
  })
}

export const fuseBodyViewV1 = (request, minimum) => {
  if (request.body.byteLength < minimum) return invalid()
  return new DataView(request.body.buffer, request.body.byteOffset, request.body.byteLength)
}

export const fuseNameV1 = (request, offset = 0) => {
  const bytes = request.body.slice(offset)
  if (bytes.byteLength < 2 || bytes.at(-1) !== 0 || bytes.slice(0, -1).includes(0)) return invalid()
  const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, -1))
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.length > 255) return invalid()
  return name
}

export const fuseNamesV1 = (request, offset, count) => {
  const bytes = request.body.slice(offset)
  const names = []
  let start = 0
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue
    const item = { ...request, body: bytes.slice(start, index + 1) }
    names.push(fuseNameV1(item))
    start = index + 1
  }
  if (start !== bytes.byteLength || names.length !== count) return invalid()
  return Object.freeze(names)
}

const output = (unique, error, body = new Uint8Array()) => {
  const bytes = new Uint8Array(16 + body.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, bytes.byteLength, true)
  view.setInt32(4, error === 0 ? 0 : -Math.abs(error), true)
  view.setBigUint64(8, unique, true)
  bytes.set(body, 16)
  return bytes
}

export const encodeV86FuseErrorV1 = (request, error) => output(request.unique, error)
export const encodeV86FuseResultV1 = (request, body) => output(request.unique, 0, body)

export const encodeV86FuseInitV1 = request => {
  const body = new Uint8Array(64)
  const view = new DataView(body.buffer)
  view.setUint32(0, 7, true)
  view.setUint32(4, 39, true)
  view.setUint32(12, FUSE_ATOMIC_O_TRUNC, true)
  view.setUint16(16, 16, true)
  view.setUint16(18, 12, true)
  view.setUint32(20, 64 * 1024, true)
  view.setUint32(24, 1, true)
  view.setUint16(28, 16, true)
  return output(request.unique, 0, body)
}

const attr = (nodeId, metadata) => {
  const value = new Uint8Array(88)
  const view = new DataView(value.buffer)
  const size = BigInt(metadata.kind === 'directory' ? 0 : metadata.size)
  view.setBigUint64(0, nodeId, true)
  view.setBigUint64(8, size, true)
  view.setBigUint64(16, (size + 511n) / 512n, true)
  view.setUint32(60, metadata.kind === 'directory' ? 0o040755 : 0o100644, true)
  view.setUint32(64, metadata.kind === 'directory' ? 2 : 1, true)
  view.setUint32(68, 1000, true)
  view.setUint32(72, 1000, true)
  view.setUint32(80, 4096, true)
  return value
}

export const encodeV86FuseAttrV1 = (request, nodeId, metadata) => {
  const body = new Uint8Array(104)
  body.set(attr(nodeId, metadata), 16)
  return output(request.unique, 0, body)
}

export const encodeV86FuseEntryV1 = (request, nodeId, metadata, handleId) => {
  const entry = new Uint8Array(handleId == null ? 128 : 144)
  const view = new DataView(entry.buffer)
  view.setBigUint64(0, nodeId, true)
  view.setBigUint64(8, 1n, true)
  entry.set(attr(nodeId, metadata), 40)
  if (handleId != null) view.setBigUint64(128, handleId, true)
  return output(request.unique, 0, entry)
}

export const encodeV86FuseOpenV1 = (request, handleId) => {
  const body = new Uint8Array(16)
  new DataView(body.buffer).setBigUint64(0, handleId, true)
  return output(request.unique, 0, body)
}

export const encodeV86FuseWriteV1 = (request, size) => {
  const body = new Uint8Array(8)
  new DataView(body.buffer).setUint32(0, size, true)
  return output(request.unique, 0, body)
}

const align8 = value => (value + 7) & ~7

export const encodeV86FuseDirectoryV1 = (request, entries, offset, maximum, inode) => {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maximum) || maximum < 0) return invalid()
  const encoder = new TextEncoder()
  const parts = entries.map((entry, index) => {
    const name = encoder.encode(entry.name)
    if (name.byteLength === 0 || name.byteLength > 255 || name.includes(0)) return invalid()
    const bytes = new Uint8Array(align8(24 + name.byteLength))
    const view = new DataView(bytes.buffer)
    view.setBigUint64(0, inode(entry.path), true)
    view.setBigUint64(8, BigInt(index + 1), true)
    view.setUint32(16, name.byteLength, true)
    view.setUint32(20, entry.kind === 'directory' ? 4 : entry.kind === 'symlink' ? 10 : 8, true)
    bytes.set(name, 24)
    return bytes
  })
  const selected = []
  let total = 0
  for (let index = offset; index < parts.length; index += 1) {
    if (total + parts[index].byteLength > maximum) break
    selected.push(parts[index])
    total += parts[index].byteLength
  }
  const body = new Uint8Array(total)
  let cursor = 0
  for (const part of selected) {
    body.set(part, cursor)
    cursor += part.byteLength
  }
  return output(request.unique, 0, body)
}

export const encodeV86FuseStatfsV1 = request => {
  const body = new Uint8Array(80)
  const view = new DataView(body.buffer)
  view.setBigUint64(0, 1_048_576n, true)
  view.setBigUint64(8, 1_048_576n, true)
  view.setBigUint64(16, 1_048_576n, true)
  view.setBigUint64(24, 1_000_000n, true)
  view.setBigUint64(32, 1_000_000n, true)
  view.setUint32(40, 4096, true)
  view.setUint32(44, 255, true)
  view.setUint32(48, 4096, true)
  return output(request.unique, 0, body)
}
