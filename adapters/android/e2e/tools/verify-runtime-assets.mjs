import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const normalizedRelative = (root, target) => relative(root, target).split(sep).join('/')
const listFiles = root =>
  readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const target = resolve(root, entry.name)
    return entry.isDirectory() ? listFiles(target) : [target]
  })

export const verifyRuntimeAssets = (manifest, outputRoot) => {
  const expected = new Set([...manifest.assets.map(asset => asset.path), 'runtime/asset-manifest.json'])
  const actual = new Set(listFiles(outputRoot).map(file => normalizedRelative(outputRoot, file)))
  if (expected.size !== actual.size || [...expected].some(file => !actual.has(file))) {
    throw new Error('Generated runtime assets contain a stale, missing, or extra file')
  }
  for (const asset of manifest.assets) {
    if (sha256(readFileSync(resolve(outputRoot, asset.path))) !== asset.sha256) {
      throw new Error(`Generated runtime asset digest mismatch: ${asset.path}`)
    }
  }
}
