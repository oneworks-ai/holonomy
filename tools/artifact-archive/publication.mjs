import { constants } from 'node:fs'
import { copyFile, link } from 'node:fs/promises'
import { join } from 'node:path'

import { describeFile } from './files.mjs'

export const publishPreparedArtifact = async (prepared, destination, archive) => {
  if (!/^holo-[\w.-]+\.tar\.gz$/u.test(archive)) throw new Error('Invalid archive filename')
  for (const path of [archive, 'manifest.json', 'SHA256SUMS']) {
    await copyFile(join(prepared, path), join(destination, path), constants.COPYFILE_EXCL)
    if ((await describeFile(join(prepared, path))).sha256 !== (await describeFile(join(destination, path))).sha256) {
      throw new Error('Artifact changed during publication')
    }
  }
  // The final marker is atomic and cannot replace a pre-existing user file.
  await link(join(prepared, 'verification.json'), join(destination, 'verification.json'))
}
