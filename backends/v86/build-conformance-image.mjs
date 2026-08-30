import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import process from 'node:process'

import { canonicalJson, sha256 } from './images/image-contract.mjs'
import { createNewcArchiveFromEntriesV1, parseNewcArchiveV1 } from './images/newc.mjs'

const main = async () => {
  const [baseImagePath, supervisorPath, capabilityClientPath, selftestPath, outputPath] = process.argv.slice(2)
  if ([baseImagePath, supervisorPath, capabilityClientPath, selftestPath, outputPath].some(value => value == null)) {
    throw new TypeError(
      'Usage: node build-conformance-image.mjs <production.cpio> <holo-uvd> <hoholo> <selftest> <output.cpio>'
    )
  }

  const [baseImage, supervisor, capabilityClient, selftest] = await Promise.all(
    [baseImagePath, supervisorPath, capabilityClientPath, selftestPath].map(async path =>
      new Uint8Array(await readFile(path))
    )
  )
  const validateElf = (name, bytes) => {
    if (
      bytes.byteLength < 20 || bytes[0] !== 0x7F || bytes[1] !== 0x45 || bytes[2] !== 0x4C || bytes[3] !== 0x46 ||
      bytes[4] !== 1 || bytes[5] !== 1 || bytes[18] !== 3 || bytes[19] !== 0
    ) throw new TypeError(`${name} must be a Linux i386 ELF`)
  }
  validateElf('holo-uvd', supervisor)
  validateElf('hoholo', capabilityClient)
  validateElf('holo-v86-selftest', selftest)

  const entries = parseNewcArchiveV1(baseImage)
  const byName = new Map(entries.map(value => [value.name, value]))
  if (byName.size !== entries.length) throw new TypeError('Production v86 image contains duplicate entries')
  if (byName.has('holo-selftest') || byName.has('usr/bin/holo-v86-selftest')) {
    throw new TypeError('Production v86 image already contains the conformance selftest')
  }
  for (
    const required of [
      'etc',
      'etc/holo/image-profile-v1.json',
      'lib/modules',
      'sbin/holo-uvd',
      'sbin/modprobe',
      'usr/bin/hoholo'
    ]
  ) {
    if (!byName.has(required)) throw new TypeError(`Production v86 conformance base is missing ${required}`)
  }
  const profileEntry = byName.get('etc/holo/image-profile-v1.json')
  const profile = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(profileEntry.bytes))
  if (
    profile?.schemaVersion !== 1 || profile.architecture !== 'linux-x86-32' ||
    !['agent', 'base'].includes(profile.profileId) || profile.kernel == null || profile.rootfs == null
  ) throw new TypeError('Production v86 conformance base must be a verified base or agent image')

  const overlay = Object.freeze({
    baseImage: Object.freeze({ sha256: sha256(baseImage), size: baseImage.byteLength }),
    capabilityClient: Object.freeze({ path: '/usr/bin/hoholo', sha256: sha256(capabilityClient) }),
    fixture: Object.freeze({ path: '/usr/bin/holo-v86-selftest', sha256: sha256(selftest) }),
    schemaVersion: 1,
    supervisor: Object.freeze({ path: '/sbin/holo-uvd', sha256: sha256(supervisor) })
  })
  profile.supervisor = overlay.supervisor
  profile.capabilityClient = overlay.capabilityClient
  const replacements = new Map([
    ['etc/holo/conformance-overlay-v1.json', {
      bytes: new TextEncoder().encode(canonicalJson(overlay)),
      mode: 0o100444,
      name: 'etc/holo/conformance-overlay-v1.json'
    }],
    ['etc/holo/image-profile-v1.json', {
      bytes: new TextEncoder().encode(canonicalJson(profile)),
      mode: profileEntry.mode,
      name: profileEntry.name
    }],
    ['sbin/holo-uvd', { bytes: supervisor, mode: 0o100755, name: 'sbin/holo-uvd' }],
    ['usr/bin/hoholo', { bytes: capabilityClient, mode: 0o100755, name: 'usr/bin/hoholo' }],
    ['usr/bin/holo-v86-selftest', {
      bytes: selftest,
      mode: 0o100755,
      name: 'usr/bin/holo-v86-selftest'
    }]
  ])
  const outputEntries = entries
    .filter(value => !replacements.has(value.name))
    .concat([...replacements.values()])
  const output = createNewcArchiveFromEntriesV1(outputEntries)
  const temporaryPath = `${outputPath}.${process.pid}.tmp`
  try {
    await writeFile(temporaryPath, output, { mode: 0o444 })
    await rename(temporaryPath, outputPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
  process.stdout.write(canonicalJson({
    baseProfileId: profile.profileId,
    output: outputPath,
    overlay,
    sha256: sha256(output),
    size: output.byteLength
  }))
}

void main()
