import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import { sha256 } from './image-contract.mjs'
import { parseNewcArchiveV1 } from './newc.mjs'

const [manifestInput] = process.argv.slice(2)
if (manifestInput == null) throw new TypeError('Usage: node verify-image.mjs <image-manifest.json>')
const manifestPath = resolve(manifestInput)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (
  manifest?.schemaVersion !== 1 || manifest.architecture !== 'linux-x86-32' ||
  !['agent', 'base', 'minimal'].includes(manifest.profileId) && !/^custom\./u.test(manifest.profileId)
) throw new TypeError('Invalid v86 image manifest')
const image = new Uint8Array(await readFile(join(dirname(manifestPath), manifest.artifact.name)))
const sbom = new Uint8Array(await readFile(join(dirname(manifestPath), manifest.sbom.name)))
if (
  image.byteLength !== manifest.artifact.size || sha256(image) !== manifest.artifact.sha256 ||
  sbom.byteLength !== manifest.sbom.size || sha256(sbom) !== manifest.sbom.sha256
) throw new TypeError('Invalid v86 image artifact digest')
const entries = parseNewcArchiveV1(image)
const byName = new Map(entries.map(value => [value.name, value]))
if (
  byName.size !== entries.length || !byName.has('sbin/holo-uvd') ||
  byName.has('holo-selftest') || byName.has('usr/bin/holo-v86-selftest')
) {
  throw new TypeError('Invalid v86 image contents')
}
const embeddedEntry = byName.get('etc/holo/image-profile-v1.json')
if (embeddedEntry == null) throw new TypeError('Missing v86 image profile')
const embedded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(embeddedEntry.bytes))
if (
  embedded?.schemaVersion !== 1 || embedded.profileId !== manifest.profileId ||
  embedded.supervisor?.sha256 !== manifest.supervisorSha256 ||
  JSON.stringify(embedded.executables) !== JSON.stringify(manifest.executables)
) throw new TypeError('Invalid embedded v86 image profile')
for (const executable of manifest.executables) {
  const entry = byName.get(executable.path.slice(1))
  if (entry == null || (entry.mode & 0o111) === 0) throw new TypeError(`Missing image executable: ${executable.path}`)
}
const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sbom))
if (
  document?.spdxVersion !== 'SPDX-2.3' || document.packages?.length !== manifest.packageCount ||
  document.documentNamespace !== `https://holonomy.dev/spdx/v86/${manifest.profileId}/${manifest.artifact.sha256}`
) throw new TypeError('Invalid v86 image SBOM')
process.stdout.write(`${
  JSON.stringify({
    entries: entries.length,
    packageCount: manifest.packageCount,
    profileId: manifest.profileId,
    sha256: manifest.artifact.sha256,
    verified: true
  })
}\n`)
