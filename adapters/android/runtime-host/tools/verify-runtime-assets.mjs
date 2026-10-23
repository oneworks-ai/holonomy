import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const normalizedRelative = (root, target) => relative(root, target).split(sep).join('/')
const digestPattern = /^[0-9a-f]{64}$/u
const isSafePath = path =>
  typeof path === 'string' &&
  path !== '' &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
const isSafeTypescriptSourcePath = path =>
  isSafePath(path) && (path.startsWith('src/') || (path.startsWith('packages/') && path.includes('/src/')))
const listFiles = root =>
  readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const target = resolve(root, entry.name)
    return entry.isDirectory() ? listFiles(target) : [target]
  })

export const verifyRuntimeAssets = (manifest, outputRoot) => {
  if (manifest?.schemaVersion !== 2 || !Array.isArray(manifest.typescriptSources)) {
    throw new Error('Generated runtime asset manifest has an invalid schema')
  }
  if (manifest.typescriptSources.length === 0) {
    throw new Error('Generated runtime asset manifest has no TypeScript source provenance')
  }
  const sourcePaths = new Set()
  for (const source of manifest.typescriptSources) {
    if (
      !isSafeTypescriptSourcePath(source?.path) ||
      !digestPattern.test(source?.sha256 ?? '') ||
      sourcePaths.has(source.path)
    ) throw new Error('Generated runtime asset manifest has invalid TypeScript source provenance')
    sourcePaths.add(source.path)
  }
  if (!Array.isArray(manifest.assets)) throw new Error('Generated runtime asset manifest has no assets')
  const assetPaths = new Set()
  const runtimeOutputPaths = new Set()
  for (const asset of manifest.assets) {
    if (
      !isSafePath(asset?.path) ||
      !asset.path.startsWith('runtime/') ||
      asset.path === 'runtime/asset-manifest.json' ||
      !digestPattern.test(asset?.sha256 ?? '') ||
      typeof asset.kind !== 'string' ||
      assetPaths.has(asset.path) ||
      (asset.guestReadable === true && asset.kind !== 'fixture')
    ) throw new Error('Generated runtime asset manifest has an invalid asset entry')
    assetPaths.add(asset.path)
    if (asset.kind === 'runtime-output') runtimeOutputPaths.add(asset.path)
  }
  if (!Array.isArray(manifest.moduleAliases) || manifest.moduleAliases.length === 0) {
    throw new Error('Generated runtime asset manifest has no workspace module aliases')
  }
  const aliasSpecifiers = new Set()
  for (const alias of manifest.moduleAliases) {
    if (
      typeof alias?.specifier !== 'string' ||
      !/^@holonomyjs\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/u.test(alias.specifier) ||
      aliasSpecifiers.has(alias.specifier) ||
      !runtimeOutputPaths.has(alias?.path)
    ) throw new Error('Generated runtime asset manifest has an invalid workspace module alias')
    aliasSpecifiers.add(alias.specifier)
  }
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
