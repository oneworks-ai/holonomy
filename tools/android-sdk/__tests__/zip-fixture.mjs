import { Buffer } from 'node:buffer'

import { zipCrc32 } from '../zip.mjs'

export const storedZip = entries => {
  const locals = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const bytes = Buffer.from(entry.data ?? 'fixture')
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034B50)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt32LE(zipCrc32(bytes), 14)
    header.writeUInt32LE(bytes.length, 18)
    header.writeUInt32LE(bytes.length, 22)
    header.writeUInt16LE(name.length, 26)
    const meta = Buffer.alloc(46)
    meta.writeUInt32LE(0x02014B50)
    meta.writeUInt16LE(0x0314, 4)
    meta.writeUInt16LE(20, 6)
    meta.writeUInt16LE(0x0800, 8)
    meta.writeUInt32LE(zipCrc32(bytes), 16)
    meta.writeUInt32LE(bytes.length, 20)
    meta.writeUInt32LE(bytes.length, 24)
    meta.writeUInt16LE(name.length, 28)
    meta.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    meta.writeUInt32LE(offset, 42)
    locals.push(header, name, bytes)
    central.push(meta, name)
    offset += header.length + name.length + bytes.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
