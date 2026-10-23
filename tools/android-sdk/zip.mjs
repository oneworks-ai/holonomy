import { Buffer } from 'node:buffer'
import { inflateRawSync } from 'node:zlib'

const MAX = 64 * 1024 * 1024
const fail = () => {
  throw new Error('Invalid or unsafe Android AAR ZIP structure')
}
const table = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ value >>> 1 : value >>> 1
  return value >>> 0
})
export const zipCrc32 = bytes => {
  let crc = 0xFFFFFFFF
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ crc >>> 8
  return (crc ^ 0xFFFFFFFF) >>> 0
}

const safeName = bytes => {
  const name = bytes.toString('utf8')
  const parts = name.replace(/\/$/u, '').split('/')
  if (
    bytes.length === 0 || bytes.length > 512 || !Buffer.from(name).equals(bytes) ||
    !/^[\w%+@./$-]+$/u.test(name) || parts.some(part => !part || part === '.' || part === '..') ||
    parts.some(part =>
      part.startsWith('.') ||
      ['e2e', 'backendprobe', 'backend-probe', 'runtimefixtures', 'runtime-fixtures', 'v86-assets', 'linux-assets']
        .includes(part.toLowerCase())
    ) ||
    /(?:^|\/)(?:v86\.wasm|libv86\.js|agent\.cpio|kernel\.bin|local\.properties)$/iu.test(name) || /\.apk$/iu.test(name)
  ) return fail()
  return name
}

const extraFields = bytes => {
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) return fail()
    const id = bytes.readUInt16LE(offset)
    const size = bytes.readUInt16LE(offset + 2)
    if (![0x5455, 0x7875, 0xCAFE, 0xD935].includes(id) || offset + 4 + size > bytes.length) return fail()
    offset += 4 + size
  }
}

export const readAarZip = bytes => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > MAX) return fail()
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054B50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
      end = offset
      break
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) return fail()
  const count = bytes.readUInt16LE(end + 10)
  const start = bytes.readUInt32LE(end + 16)
  if (
    !count || count > 4096 || bytes.readUInt16LE(end + 8) !== count ||
    start + bytes.readUInt32LE(end + 12) !== end
  ) return fail()
  const entries = new Map()
  const folded = new Set()
  const ranges = []
  let total = 0
  let cursor = start
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014B50) return fail()
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const crc = bytes.readUInt32LE(cursor + 16)
    const compressed = bytes.readUInt32LE(cursor + 20)
    const size = bytes.readUInt32LE(cursor + 24)
    const nameSize = bytes.readUInt16LE(cursor + 28)
    const next = cursor + 46 + nameSize + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32)
    const local = bytes.readUInt32LE(cursor + 42)
    if (
      next > end || bytes.readUInt16LE(cursor + 34) || flags & ~0x080E || ![0, 8].includes(method) ||
      bytes.readUInt16LE(cursor + 6) > 20 || method === 0 && flags & 6 ||
      compressed > MAX || size > 32 * 1024 * 1024 || local + 30 > start
    ) return fail()
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize)
    extraFields(bytes.subarray(cursor + 46 + nameSize, cursor + 46 + nameSize + bytes.readUInt16LE(cursor + 30)))
    const name = safeName(nameBytes)
    const directory = name.endsWith('/')
    const attributes = bytes.readUInt32LE(cursor + 38)
    const mode = attributes >>> 16
    const type = mode & 0xF000
    const identity = name.replace(/\/$/u, '').toLowerCase()
    if (
      (type && type !== (directory ? 0x4000 : 0x8000)) || mode & 0o7000 ||
      attributes & 0x440 || (attributes & 0x10) && !directory ||
      folded.has(identity) || directory && (size !== 0 || crc !== 0 || compressed !== (method === 0 ? 0 : 2))
    ) return fail()
    folded.add(identity)
    if (
      bytes.readUInt32LE(local) !== 0x04034B50 || bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 4) > 20
    ) return fail()
    const localNameSize = bytes.readUInt16LE(local + 26)
    const data = local + 30 + localNameSize + bytes.readUInt16LE(local + 28)
    if (
      localNameSize !== nameSize || data + compressed > start ||
      !bytes.subarray(local + 30, local + 30 + localNameSize).equals(nameBytes)
    ) return fail()
    extraFields(bytes.subarray(local + 30 + localNameSize, data))
    let limit = data + compressed
    if (flags & 8) {
      if (
        ![0, crc].includes(bytes.readUInt32LE(local + 14)) ||
        ![0, compressed].includes(bytes.readUInt32LE(local + 18)) ||
        ![0, size].includes(bytes.readUInt32LE(local + 22))
      ) return fail()
      if (limit + 12 > start) return fail()
      const descriptor = bytes.readUInt32LE(limit) === 0x08074B50 ? limit + 4 : limit
      if (
        descriptor + 12 > start || bytes.readUInt32LE(descriptor) !== crc ||
        bytes.readUInt32LE(descriptor + 4) !== compressed || bytes.readUInt32LE(descriptor + 8) !== size
      ) return fail()
      limit = descriptor + 12
    } else if (
      bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed ||
      bytes.readUInt32LE(local + 22) !== size
    ) return fail()
    total += size
    if (total > MAX) return fail()
    entries.set(name, { name, directory, size, compressed, method, crc, data, bytes })
    ranges.push([local, limit])
    cursor = next
  }
  if (cursor !== end) return fail()
  ranges.sort((a, b) => a[0] - b[0])
  if (
    ranges[0][0] !== 0 || ranges.at(-1)[1] !== start ||
    ranges.some(([offset], index) => index > 0 && ranges[index - 1][1] !== offset)
  ) return fail()
  const regular = new Set(
    [...entries.values()].filter(entry => !entry.directory).map(entry => entry.name.toLowerCase())
  )
  for (const name of entries.keys()) {
    const parts = name.split('/')
    for (let count = 1; count < parts.length; count++) {
      if (regular.has(parts.slice(0, count).join('/').toLowerCase())) return fail()
    }
  }
  return entries
}

export const readAarEntry = (entries, name, maximum = 8 * 1024 * 1024) => {
  const entry = entries.get(name)
  if (!entry || entry.directory || entry.size > maximum) return fail()
  const input = entry.bytes.subarray(entry.data, entry.data + entry.compressed)
  const output = entry.method === 0 ? input : inflateRawSync(input, { maxOutputLength: maximum })
  if (output.length !== entry.size || zipCrc32(output) !== entry.crc) return fail()
  return output
}
