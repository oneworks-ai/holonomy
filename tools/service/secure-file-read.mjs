import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

import { serviceError } from './errors.mjs'

const invalidFile = label => serviceError('service.state_corrupt', `${label} is invalid`)

export const readBoundedRegularFile = async (path, options = {}) => {
  const maxBytes = options.maxBytes ?? 1024 * 1024
  let descriptor
  try {
    descriptor = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const metadata = await descriptor.stat()
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maxBytes) {
      throw invalidFile(options.label ?? 'File')
    }
    if (
      options.ownerOnly === true && (metadata.mode & 0o077) !== 0 ||
      options.ownerUid !== undefined && metadata.uid !== options.ownerUid
    ) {
      throw invalidFile(options.label ?? 'File')
    }
    const output = Buffer.allocUnsafe(metadata.size)
    let offset = 0
    while (offset < output.byteLength) {
      const result = await descriptor.read(output, offset, output.byteLength - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    const current = await descriptor.stat()
    if (
      offset !== output.byteLength || current.size !== metadata.size ||
      options.ownerUid !== undefined && (
          current.uid !== options.ownerUid || current.dev !== metadata.dev ||
          current.ino !== metadata.ino || current.mtimeMs !== metadata.mtimeMs
        )
    ) {
      throw invalidFile(options.label ?? 'File')
    }
    return output
  } finally {
    await descriptor?.close()
  }
}
