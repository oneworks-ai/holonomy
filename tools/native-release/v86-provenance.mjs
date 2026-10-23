import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { copyLicense } from './license-provenance.mjs'
import { describeFile } from './manifest.mjs'

export const prepareV86Provenance = async (
  { root, provenanceRoot, licenses, included, components, spdxFiles, pnpm, v86 }
) => {
  if (v86 != null) {
    const locked = pnpm.filter(value => value.name === 'v86')
    if (locked.length !== 1 || locked[0].version !== '0.5.432' || !locked[0].checksum) {
      throw new Error('v86 npm lock entry is not the reviewed version')
    }
    const npmRoot = join(root, 'node_modules/v86')
    const installed = JSON.parse(await readFile(join(npmRoot, 'package.json'), 'utf8'))
    if (
      installed.name !== 'v86' ||
      ![locked[0].version, `${locked[0].version}+gf3d4472`].includes(installed.version) ||
      installed.license !== 'BSD-2-Clause'
    ) throw new Error('Installed v86 package identity differs from pnpm lock')
    const evidence = [
      ['libv86.js', 'build/libv86.js'],
      ['v86.wasm', 'build/v86.wasm'],
      ['v86-LICENSE', 'LICENSE']
    ]
    const embedded = {}
    for (const [sourceName, npmName] of evidence) {
      const sourcePath = join(root, 'adapters/desktop/v8-host/assets', sourceName)
      const from = await describeFile(sourcePath)
      const installedFile = await describeFile(join(npmRoot, npmName))
      if (from.sha256 !== installedFile.sha256) {
        throw new Error(`Embedded v86 asset differs from installed npm package: ${sourceName}`)
      }
      embedded[sourceName] = from
    }
    if (
      embedded['libv86.js'].sha256 !==
        v86.manifest.sourceAssetInputs['adapters/desktop/v8-host/assets/libv86.js'].sha256 ||
      embedded['v86.wasm'].sha256 !== v86.manifest.sourceAssetInputs['adapters/desktop/v8-host/assets/v86.wasm'].sha256
    ) throw new Error('v86 source asset digest changed during packaging')
    await copyLicense(
      join(root, 'adapters/desktop/v8-host/assets/v86-LICENSE'),
      join(licenses, 'v86-LICENSE'),
      embedded['v86-LICENSE'].sha256
    )
    included.push('licenses/v86-LICENSE')
    const imageSourceLocks = {}
    await mkdir(join(provenanceRoot, 'v86-image'))
    for (
      const name of [
        'alpine-source-v1.json',
        'alpine-packages-lock-v1.json',
        'alpine-kernel-lock-v1.json',
        'profiles-v1.json'
      ]
    ) {
      const target = join(provenanceRoot, 'v86-image', name)
      await copyFile(join(root, 'backends/v86/images', name), target)
      imageSourceLocks[name] = await describeFile(target)
      included.push(`provenance/v86-image/${name}`)
    }
    components.push({
      name: 'v86',
      version: locked[0].version,
      licenseDeclared: 'BSD-2-Clause',
      licenseFile: 'licenses/v86-LICENSE',
      licenseFileSha256: embedded['v86-LICENSE'].sha256,
      npmTarball: locked[0].tarball,
      npmIntegrity: locked[0].checksum,
      embeddedAssets: embedded,
      linuxImageSpdx: v86.manifest.agentSpdxInventory,
      linuxImageManifest: v86.manifest.agentManifest,
      linuxImageSourceLocks: imageSourceLocks
    })
    for (const [name, value] of Object.entries(v86.manifest.assets)) {
      spdxFiles.push({
        SPDXID: `SPDXRef-File-v86-${name.replaceAll('.', '-')}`,
        fileName: `./private/v86-assets/${name}`,
        checksums: [{ algorithm: 'SHA256', checksumValue: value.sha256 }],
        licenseConcluded: 'NOASSERTION',
        copyrightText: 'NOASSERTION'
      })
    }
  }
}
