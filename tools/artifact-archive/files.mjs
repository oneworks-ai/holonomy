import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export const readArtifactFile = async (path, maximum = Number.MAX_SAFE_INTEGER) => {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error('Artifact inputs must be bounded regular files')
    throw error
  }
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > maximum) throw new Error('Artifact inputs must be bounded regular files')
    const bytes = await file.readFile()
    const after = await file.stat()
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('Artifact input changed while reading')
    }
    return bytes
  } finally {
    await file.close()
  }
}

export const describeFile = async path => {
  const bytes = await readArtifactFile(path)
  return { bytes: bytes.length, sha256: sha256(bytes) }
}
