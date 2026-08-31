import { createHash } from 'node:crypto'

const decoder = new TextDecoder('utf-8', { fatal: true })
const SHA256 = /^[a-f\d]{64}$/u
const PROFILE_ID = /^(?:agent|base|minimal|custom\.[a-z\d][a-z\d.-]{0,63})$/u
const EXECUTABLE_ID = /^[a-z][a-z\d.-]{0,63}$/u

const invalid = () => {
  throw new TypeError('Invalid installed v86 image bundle')
}

const exact = (value, keys) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid()
  return value
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const align4 = value => (value + 3) & ~3
const field = (bytes, offset) => Number.parseInt(decoder.decode(bytes.slice(offset, offset + 8)), 16)

const parseNewc = bytes => {
  if (!(bytes instanceof Uint8Array)) return invalid()
  const output = []
  let offset = 0
  while (offset + 110 <= bytes.byteLength) {
    if (decoder.decode(bytes.slice(offset, offset + 6)) !== '070701') return invalid()
    const mode = field(bytes, offset + 14)
    const size = field(bytes, offset + 54)
    const nameSize = field(bytes, offset + 94)
    if (!Number.isSafeInteger(mode) || !Number.isSafeInteger(size) || size < 0 || nameSize <= 0) return invalid()
    const nameStart = offset + 110
    const nameEnd = nameStart + nameSize
    if (nameEnd > bytes.byteLength || bytes[nameEnd - 1] !== 0) return invalid()
    const name = decoder.decode(bytes.slice(nameStart, nameEnd - 1))
    const dataStart = align4(nameEnd)
    const dataEnd = dataStart + size
    if (dataEnd > bytes.byteLength) return invalid()
    if (name === 'TRAILER!!!') return Object.freeze(output)
    if (
      name === '' || name.startsWith('/') || name.endsWith('/') || name.includes('\0') ||
      name.split('/').some(value => value === '' || value === '.' || value === '..')
    ) return invalid()
    output.push(Object.freeze({ bytes: bytes.slice(dataStart, dataEnd), mode, name }))
    offset = align4(dataEnd)
  }
  return invalid()
}

const json = bytes => {
  if (!(bytes instanceof Uint8Array)) return invalid()
  try {
    return JSON.parse(decoder.decode(bytes))
  } catch {
    return invalid()
  }
}

const artifact = value => {
  const input = exact(value, ['name', 'sha256', 'size'])
  if (
    typeof input.name !== 'string' || !/^[a-z\d][\w.-]{0,127}$/u.test(input.name) ||
    !SHA256.test(input.sha256) || !Number.isSafeInteger(input.size) || input.size <= 0
  ) return invalid()
  return Object.freeze({ name: input.name, sha256: input.sha256, size: input.size })
}

const executables = value => {
  if (!Array.isArray(value) || value.length > 128) return invalid()
  const output = value.map(item => {
    const input = exact(item, ['executableId', 'path', 'shell'])
    if (
      !EXECUTABLE_ID.test(input.executableId) || typeof input.path !== 'string' ||
      !input.path.startsWith('/') || input.path === '/' || input.path.endsWith('/') ||
      input.path.includes('\0') || typeof input.shell !== 'boolean'
    ) return invalid()
    return Object.freeze({ executableId: input.executableId, path: input.path, shell: input.shell })
  })
  if (
    new Set(output.map(item => item.executableId)).size !== output.length ||
    new Set(output.map(item => item.path)).size !== output.length
  ) return invalid()
  return Object.freeze(output)
}

const processExecutables = profile => {
  if (!Array.isArray(profile?.executables)) return invalid()
  return profile.executables.map(item => {
    const executable = item?.executable
    if (executable?.kind !== 'guestPath') return invalid()
    return Object.freeze({
      executableId: item.executableId,
      path: executable.path,
      shell: item.shell
    })
  })
}

export const verifyInstalledV86ImageBundleV1 = async (profile, readArtifact) => {
  if (typeof readArtifact !== 'function') return invalid()
  const initrd = profile?.backend?.configuration?.artifacts?.initrd
  if (initrd == null || typeof initrd.artifactId !== 'string' || !initrd.artifactId.endsWith('.cpio')) {
    return invalid()
  }
  const baseName = initrd.artifactId.slice(0, -'.cpio'.length)
  const [image, manifestBytes] = await Promise.all([
    readArtifact(initrd.artifactId),
    readArtifact(`${baseName}.manifest.json`)
  ])
  const manifest = exact(json(manifestBytes), [
    'architecture',
    'artifact',
    'capabilityClientSha256',
    'executables',
    'kernel',
    'packageCount',
    'profileDigest',
    'profileId',
    'rootfs',
    'sbom',
    'schemaVersion',
    'supervisorSha256'
  ])
  if (
    manifest.schemaVersion !== 1 || manifest.architecture !== 'linux-x86-32' ||
    !PROFILE_ID.test(manifest.profileId) || !SHA256.test(manifest.profileDigest) ||
    !SHA256.test(manifest.supervisorSha256) || !Number.isSafeInteger(manifest.packageCount) ||
    manifest.packageCount < 0
  ) return invalid()
  const imageArtifact = artifact(manifest.artifact)
  const sbomArtifact = artifact(manifest.sbom)
  if (
    imageArtifact.name !== initrd.artifactId || imageArtifact.sha256 !== initrd.sha256 ||
    image.byteLength !== imageArtifact.size || digest(image) !== imageArtifact.sha256
  ) return invalid()
  const sbom = await readArtifact(sbomArtifact.name)
  if (sbom.byteLength !== sbomArtifact.size || digest(sbom) !== sbomArtifact.sha256) return invalid()

  const allowedExecutables = executables(manifest.executables)
  const allowed = new Map(allowedExecutables.map(item => [item.path, item]))
  for (const selected of processExecutables(profile)) {
    const expected = allowed.get(selected.path)
    if (expected == null || selected.shell && !expected.shell) return invalid()
  }

  const entries = parseNewc(image)
  const byName = new Map(entries.map(item => [item.name, item]))
  if (
    byName.size !== entries.length || !byName.has('sbin/holo-uvd') ||
    byName.has('holo-selftest') || byName.has('usr/bin/holo-v86-selftest')
  ) return invalid()
  const embeddedEntry = byName.get('etc/holo/image-profile-v1.json')
  if (embeddedEntry == null) return invalid()
  const embedded = json(embeddedEntry.bytes)
  if (
    embedded?.schemaVersion !== 1 || embedded.architecture !== 'linux-x86-32' ||
    embedded.profileId !== manifest.profileId || embedded.profileDigest !== manifest.profileDigest ||
    embedded.supervisor?.sha256 !== manifest.supervisorSha256 ||
    JSON.stringify(embedded.executables) !== JSON.stringify(allowedExecutables)
  ) return invalid()
  for (const executable of allowedExecutables) {
    const entry = byName.get(executable.path.slice(1))
    if (entry == null || (entry.mode & 0o111) === 0) return invalid()
  }
  const document = json(sbom)
  if (
    document?.spdxVersion !== 'SPDX-2.3' || document.packages?.length !== manifest.packageCount ||
    document.documentNamespace !==
      `https://holonomy.dev/spdx/v86/${manifest.profileId}/${manifest.artifact.sha256}`
  ) return invalid()
  return Object.freeze({
    artifactSha256: imageArtifact.sha256,
    executableIds: Object.freeze(allowedExecutables.map(item => item.executableId)),
    profileDigest: manifest.profileDigest,
    profileId: manifest.profileId,
    sbomSha256: sbomArtifact.sha256
  })
}
