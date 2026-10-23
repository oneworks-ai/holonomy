import { sha256 } from '../artifact-archive/files.mjs'
import { readAarEntry, readAarZip } from './zip.mjs'

export const verifyAarEnvelope = bytes => {
  const entries = readAarZip(bytes)
  if (!entries.has('AndroidManifest.xml') || !entries.has('classes.jar')) throw new Error('Invalid Android AAR')
  for (const [name, entry] of entries) {
    if (!entry.directory) readAarEntry(entries, name, 32 * 1024 * 1024)
  }
  return entries
}

export const verifyRuntimeAar = (bytes, expectedBootstrap) => {
  const entries = verifyAarEnvelope(bytes)
  const manifestBytes = readAarEntry(entries, 'assets/runtime/asset-manifest.json')
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (
    ![1, 2].includes(manifest.schemaVersion) || !Array.isArray(manifest.assets) ||
    manifest.assets.length === 0 || manifest.assets.length > 2048 || !Array.isArray(manifest.moduleAliases)
  ) throw new Error('Invalid Runtime asset manifest')
  const expected = new Set(['assets/runtime/asset-manifest.json'])
  let total = 0
  for (const asset of manifest.assets) {
    if (
      typeof asset.path !== 'string' || !/^runtime\/[\w./-]+$/u.test(asset.path) ||
      asset.path.split('/').some(part => !part || part === '.' || part === '..') ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256) || typeof asset.source !== 'string' ||
      asset.source.includes('e2e/') || asset.source.startsWith('conformance/')
    ) throw new Error('Runtime AAR contains an invalid or diagnostic asset')
    const name = `assets/${asset.path}`
    if (expected.has(name)) throw new Error('Duplicate Runtime asset')
    expected.add(name)
    const bytes = readAarEntry(entries, name)
    total += bytes.length
    if (total > 64 * 1024 * 1024 || sha256(bytes) !== asset.sha256) throw new Error('Runtime AAR asset digest mismatch')
  }
  const actual = [...entries.keys()].filter(name => name.startsWith('assets/runtime/') && !name.endsWith('/'))
  if (actual.length !== expected.size || actual.some(name => !expected.has(name))) {
    throw new Error('Runtime AAR has unmanifested assets')
  }
  const bootstrap = manifest.assets.find(asset => asset.path === 'runtime/bootstrap.mjs')
  if (
    bootstrap?.source !== 'adapters/android/runtime-host/src/runtimeBootstrap/bootstrap.mjs' ||
    expectedBootstrap == null || bootstrap.sha256 !== sha256(expectedBootstrap)
  ) {
    throw new Error('Runtime AAR does not contain the production bootstrap')
  }
  return { sha256: sha256(manifestBytes), assets: manifest.assets.length, aliases: manifest.moduleAliases.length }
}
