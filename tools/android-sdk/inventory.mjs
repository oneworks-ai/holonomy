import { Buffer } from 'node:buffer'
import { gunzipSync } from 'node:zlib'

import { artifactArchiveMembers } from '../artifact-archive/archive.mjs'
import { sha256 } from '../artifact-archive/files.mjs'
import { verifyAarEnvelope, verifyRuntimeAar } from './aar.mjs'
import { SDK_MODULES, SDK_PAYLOAD_PATHS, sdkLibraryPath } from './files.mjs'
import { readAarEntry } from './zip.mjs'

export const SDK_MAX_BYTES = 128 * 1024 * 1024
const fail = () => {
  throw new Error('Invalid Android SDK artifact inventory')
}
const nameField = bytes => bytes.toString('utf8').split('\0')[0]
const octal = bytes => {
  const text = nameField(bytes).trim()
  if (!/^[0-7]+$/u.test(text)) return fail()
  const value = Number.parseInt(text, 8)
  return Number.isSafeInteger(value) ? value : fail()
}

export const readSdkTar = compressed => {
  if (compressed.length > SDK_MAX_BYTES) return fail()
  const tar = gunzipSync(compressed, { maxOutputLength: SDK_MAX_BYTES })
  const entries = new Map()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) {
      if (offset + 1024 > tar.length || !tar.subarray(offset).every(byte => byte === 0)) return fail()
      return entries
    }
    if (entries.size >= 20_000 || header.subarray(257, 262).toString() !== 'ustar') return fail()
    let checksum = 8 * 32
    for (let index = 0; index < 512; index++) {
      if (index < 148 || index >= 156) checksum += header[index]
    }
    if (checksum !== octal(header.subarray(148, 156))) return fail()
    const prefix = nameField(header.subarray(345, 500))
    let name = (prefix ? `${prefix}/` : '') + nameField(header.subarray(0, 100))
    const type = header[156]
    if (![0, 48, 53].includes(type)) return fail()
    const directory = type === 53
    if (directory && !name.endsWith('/')) name += '/'
    const parts = (directory ? name.slice(0, -1) : name).split('/')
    if (
      !/^[\w%+@./-]+$/u.test(name) ||
      parts.some(part => !part || part === '.' || part === '..') || entries.has(name)
    ) return fail()
    const size = octal(header.subarray(124, 136))
    const mode = octal(header.subarray(100, 108))
    if (size > SDK_MAX_BYTES || directory && size !== 0 || offset + 512 + size > tar.length) return fail()
    const bytes = tar.subarray(offset + 512, offset + 512 + size)
    entries.set(name, {
      bytes,
      directory,
      mode,
      uid: octal(header.subarray(108, 116)),
      gid: octal(header.subarray(116, 124)),
      mtime: octal(header.subarray(136, 148))
    })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return fail()
}

export const validateSdkManifest = manifest => {
  if (
    manifest?.schemaVersion !== 1 || manifest.product !== 'holonomy-android-sdk' ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(manifest.version) ||
    manifest.distribution !== 'local-development-sdk' || manifest.publishReady !== false ||
    manifest.signed !== false || manifest.physicalDeviceAccepted !== false ||
    manifest.files == null || Array.isArray(manifest.files) ||
    JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(SDK_PAYLOAD_PATHS)
  ) return fail()
  for (const file of Object.values(manifest.files)) {
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256)) return fail()
  }
  return manifest
}

export const verifySdkArchive = (archive, manifestBytes) => {
  const manifest = validateSdkManifest(JSON.parse(manifestBytes.toString('utf8')))
  const name = `holo-android-sdk-${manifest.version}-development`
  const entries = readSdkTar(archive)
  const expected = artifactArchiveMembers(name, manifest)
  if (JSON.stringify([...entries.keys()].sort()) !== JSON.stringify(expected)) return fail()
  for (const [path, entry] of entries) {
    const mode = entry.directory || path.endsWith('/consumer/gradlew') ? 0o755 : 0o644
    if (entry.mode !== mode || entry.uid !== 0 || entry.gid !== 0 || entry.mtime !== 0) return fail()
  }
  const inner = entries.get(`${name}/manifest.json`)
  if (!inner || inner.directory || !inner.bytes.equals(manifestBytes)) return fail()
  for (const [path, metadata] of Object.entries(manifest.files)) {
    const entry = entries.get(`${name}/${path}`)
    if (!entry || entry.directory || entry.bytes.length !== metadata.bytes || sha256(entry.bytes) !== metadata.sha256) {
      return fail()
    }
    if (entry.mode !== (path === 'consumer/gradlew' ? 0o755 : 0o644)) return fail()
  }
  for (const module of SDK_MODULES) verifyAarEnvelope(entries.get(`${name}/${sdkLibraryPath(module)}`).bytes)
  const runtime = entries.get(`${name}/${sdkLibraryPath('runtime-host')}`).bytes
  const runtimeZip = verifyAarEnvelope(runtime)
  // Standalone verification checks packaged bytes, not publisher authenticity or current source equivalence.
  const metadata = verifyRuntimeAar(runtime, readAarEntry(runtimeZip, 'assets/runtime/bootstrap.mjs'))
  if (JSON.stringify(metadata) !== JSON.stringify(manifest.runtimeAssets)) return fail()
  return { files: Object.keys(manifest.files).length + 1, members: entries.size, manifest }
}

export const verificationRecord = (archive, manifestBytes, verified) => ({
  schemaVersion: 1,
  status: 'passed',
  kind: 'inventory-and-runtime-assets-only',
  archive: { bytes: archive.length, sha256: sha256(archive) },
  manifestSha256: sha256(manifestBytes),
  files: verified.files,
  members: verified.members,
  deviceTestExecuted: false,
  physicalDeviceAccepted: false,
  publishReady: false
})

export const sdkJson = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
