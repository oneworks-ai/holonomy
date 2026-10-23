import { readFile, writeFile } from 'node:fs/promises'

import { sha256 } from './manifest.mjs'

export const licenseSources = Object.freeze({
  rustyV8: {
    name: 'rusty-v8-LICENSE',
    sha256: '1c6356fb751d45f0c53093ebf8a7f5e580e802f51999178e19d60f3ec39e147d',
    url: 'https://raw.githubusercontent.com/denoland/rusty_v8/v152.2.0/LICENSE'
  },
  v8: {
    name: 'V8-LICENSE',
    sha256: '6ab33af8774a0f396ee3aeeb761e3229057682d6f9fa7f572e390c2cb3a6e509',
    url: 'https://raw.githubusercontent.com/v8/v8/15.2.124.1/LICENSE'
  }
})

export const copyLicense = async (source, destination, expected = null) => {
  const bytes = await readFile(source)
  const actual = sha256(bytes)
  if (expected != null && actual !== expected) throw new Error('Pinned license text changed')
  await writeFile(destination, bytes)
  return { bytes: bytes.length, sha256: actual }
}
