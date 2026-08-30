import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const align4 = value => (value + 3) & ~3
const hex = value => value.toString(16).padStart(8, '0')
const concat = values => {
  const result = new Uint8Array(values.reduce((size, value) => size + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.byteLength
  }
  return result
}
const entry = ({ bytes, inode, mode, name, links = 1 }) => {
  const nameBytes = encoder.encode(`${name}\0`)
  const header = encoder.encode([
    '070701',
    hex(inode),
    hex(mode),
    hex(0),
    hex(0),
    hex(links),
    hex(0),
    hex(bytes.byteLength),
    hex(0),
    hex(0),
    hex(0),
    hex(0),
    hex(nameBytes.byteLength),
    hex(0)
  ].join(''))
  return concat([
    header,
    nameBytes,
    new Uint8Array(align4(header.byteLength + nameBytes.byteLength) - header.byteLength - nameBytes.byteLength),
    bytes,
    new Uint8Array(align4(bytes.byteLength) - bytes.byteLength)
  ])
}

const normalizeEntries = values => {
  if (!Array.isArray(values)) throw new TypeError('Invalid newc entries')
  const names = new Set()
  const entries = values.map(value => {
    if (value == null || typeof value !== 'object' || !(value.bytes instanceof Uint8Array)) {
      throw new TypeError('Invalid newc entry')
    }
    const { bytes, mode, name } = value
    const type = mode & 0o170000
    if (
      !Number.isSafeInteger(mode) || mode < 0 || mode > 0xFFFFFFFF ||
      typeof name !== 'string' || name.length === 0 || name === 'TRAILER!!!' ||
      name.includes('\0') || name.startsWith('/') || name.endsWith('/') ||
      name.split('/').some(part => part === '' || part === '.' || part === '..') ||
      ![0o040000, 0o100000, 0o120000].includes(type) || names.has(name) ||
      type === 0o040000 && bytes.byteLength !== 0
    ) throw new TypeError(`Invalid newc entry: ${String(name)}`)
    names.add(name)
    return Object.freeze({ bytes, mode, name })
  })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  return entries
}

export const createNewcArchiveFromEntriesV1 = values => {
  const entries = normalizeEntries(values)
  const output = entries.map((value, index) =>
    entry({
      bytes: value.bytes,
      inode: index + 1,
      links: (value.mode & 0o170000) === 0o040000 ? 2 : 1,
      mode: value.mode,
      name: value.name
    })
  )
  output.push(entry({ bytes: new Uint8Array(), inode: entries.length + 1, mode: 0, name: 'TRAILER!!!' }))
  return concat(output)
}
const collect = async (root, relative = '') => {
  const result = []
  const names = await readdir(join(root, relative))
  names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  for (const name of names) {
    const path = relative === '' ? name : `${relative}/${name}`
    const stats = await lstat(join(root, path))
    if (!stats.isDirectory() && !stats.isFile() && !stats.isSymbolicLink()) {
      throw new TypeError(`Unsupported v86 image entry: ${path}`)
    }
    result.push({ path, stats })
    if (stats.isDirectory()) result.push(...await collect(root, path))
  }
  return result
}

export const createNewcArchiveV1 = async root => {
  const values = await collect(root)
  const entries = []
  for (const value of values) {
    const bytes = value.stats.isFile()
      ? new Uint8Array(await readFile(join(root, value.path)))
      : value.stats.isSymbolicLink()
      ? encoder.encode(await readlink(join(root, value.path)))
      : new Uint8Array()
    entries.push({
      bytes,
      mode: value.stats.mode & 0xFFFF,
      name: value.path
    })
  }
  return createNewcArchiveFromEntriesV1(entries)
}

const field = (bytes, offset) => Number.parseInt(decoder.decode(bytes.slice(offset, offset + 8)), 16)

export const parseNewcArchiveV1 = bytes => {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Invalid newc archive')
  const output = []
  let offset = 0
  while (offset + 110 <= bytes.byteLength) {
    if (decoder.decode(bytes.slice(offset, offset + 6)) !== '070701') throw new TypeError('Invalid newc archive')
    const mode = field(bytes, offset + 14)
    const size = field(bytes, offset + 54)
    const nameSize = field(bytes, offset + 94)
    if (!Number.isSafeInteger(size) || nameSize <= 0) throw new TypeError('Invalid newc archive')
    const nameStart = offset + 110
    const nameEnd = nameStart + nameSize
    if (nameEnd > bytes.byteLength || bytes[nameEnd - 1] !== 0) throw new TypeError('Invalid newc archive')
    const name = decoder.decode(bytes.slice(nameStart, nameEnd - 1))
    const dataStart = align4(nameEnd)
    const dataEnd = dataStart + size
    if (dataEnd > bytes.byteLength) throw new TypeError('Invalid newc archive')
    if (name === 'TRAILER!!!') return Object.freeze(output)
    output.push(Object.freeze({ bytes: bytes.slice(dataStart, dataEnd), mode, name }))
    offset = align4(dataEnd)
  }
  throw new TypeError('Invalid newc archive')
}
