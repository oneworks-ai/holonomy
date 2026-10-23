import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { copyLicense, licenseSources } from './license-provenance.mjs'
import { parseCargoInventory, parsePnpmInventory } from './lock-inventory.mjs'
import { describeFile } from './manifest.mjs'
import { json, spdxPackage } from './provenance-support.mjs'
import { writeResolvedNoticeIndex } from './resolved-notice-bundle.mjs'
import { collectResolvedNoticeIndex } from './resolved-notice-index.mjs'
import { prepareV86Provenance } from './v86-provenance.mjs'

export { parseCargoInventory, parsePnpmInventory } from './lock-inventory.mjs'
export { verifyNativeProvenance } from './provenance-verify.mjs'
export const prepareNativeProvenance = async (
  { root, bundle, build, engine, binary, v86, resolvedNotices = false }
) => {
  const provenanceRoot = join(bundle, 'provenance')
  await mkdir(provenanceRoot)
  const included = []
  for (const [name, expected] of Object.entries(build.inputs)) {
    if (!['Cargo.lock', 'pnpm-lock.yaml', 'rust-toolchain.toml'].includes(name)) {
      throw new Error('Unexpected native build input')
    }
    const target = join(provenanceRoot, name)
    await copyFile(join(root, name), target)
    const actual = await describeFile(target)
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      throw new Error(`Native lock input changed while packaging: ${name}`)
    }
    included.push(`provenance/${name}`)
  }
  const cargo = parseCargoInventory(await readFile(join(provenanceRoot, 'Cargo.lock'), 'utf8'))
  const pnpm = parsePnpmInventory(await readFile(join(provenanceRoot, 'pnpm-lock.yaml'), 'utf8'))
  const crate = cargo.find(value => value.name === 'v8' && value.version === build.expected.rustyV8)
  if (!crate?.checksum || cargo.filter(value => value.name === 'v8').length !== 1) {
    throw new Error('rusty_v8 lock entry does not match the engine')
  }
  if (build.expected.rustyV8 !== '152.2.0' || engine.v8 !== '15.2.124.1-rusty') {
    throw new Error('Engine version needs reviewed license evidence')
  }
  // This is a digest of the local linker input, not proof that a particular
  // previously-built binary was linked from it.
  const linkedArchive = await describeFile(join(root, 'target/release/gn_out/obj/librusty_v8.a'))
  const licenses = join(bundle, 'licenses')
  await mkdir(licenses)
  const rustyLicense = await copyLicense(
    new URL('./rusty-v8-LICENSE', import.meta.url),
    join(licenses, 'rusty-v8-LICENSE'),
    licenseSources.rustyV8.sha256
  )
  const v8License = await copyLicense(
    new URL('./V8-LICENSE', import.meta.url),
    join(licenses, 'V8-LICENSE'),
    licenseSources.v8.sha256
  )
  const components = [
    {
      name: 'rusty_v8',
      version: crate.version,
      licenseDeclared: 'MIT',
      licenseFile: 'licenses/rusty-v8-LICENSE',
      licenseFileSha256: rustyLicense.sha256,
      licenseSource: licenseSources.rustyV8.url,
      crateChecksumSha256: crate.checksum,
      observedLinkArchive: {
        path: 'target/release/gn_out/obj/librusty_v8.a',
        ...linkedArchive,
        upstreamReleaseUrl:
          'https://github.com/denoland/rusty_v8/releases/download/v152.2.0/librusty_v8_release_aarch64-apple-darwin.a.gz',
        assurance: 'Observed local linker input; binary linkage is not attested'
      }
    },
    {
      name: 'V8',
      version: engine.v8,
      licenseDeclared: 'BSD-3-Clause',
      licenseFile: 'licenses/V8-LICENSE',
      licenseFileSha256: v8License.sha256,
      licenseSource: licenseSources.v8.url,
      embeddedBy: 'rusty_v8; this inventory does not identify every V8 third-party subcomponent'
    }
  ]
  included.push('licenses/rusty-v8-LICENSE', 'licenses/V8-LICENSE')
  const spdxFiles = [{
    SPDXID: 'SPDXRef-File-holo',
    fileName: './bin/holo',
    checksums: [{ algorithm: 'SHA256', checksumValue: binary.sha256 }],
    licenseConcluded: 'NOASSERTION',
    copyrightText: 'NOASSERTION'
  }]
  await prepareV86Provenance({
    root,
    provenanceRoot,
    licenses,
    included,
    components,
    spdxFiles,
    pnpm,
    v86
  })
  const resolvedNoticeFiles = resolvedNotices
    ? await writeResolvedNoticeIndex({
      bundle,
      evidence: await collectResolvedNoticeIndex({ root, cargo, pnpm, engine })
    })
    : []
  included.push(...resolvedNoticeFiles)
  const notices = {
    schemaVersion: 1,
    scope:
      'Development artifact; Cargo and pnpm entries are lock inventories, not a resolved linkage or redistribution closure',
    sourceInputs: Object.fromEntries(Object.entries(build.inputs).map(([name, value]) => [name, value.sha256])),
    embeddedRuntimeAssets: {
      runtime: engine.runtimeAssetSha256,
      hostControl: engine.hostControlAssetSha256,
      pluginValidator: engine.pluginValidatorAssetSha256,
      modulePlanner: engine.modulePlannerAssetSha256
    },
    components,
    ...(resolvedNotices ? { resolvedNoticeIndex: 'provenance/resolved-notice-index.json' } : {}),
    coverage: {
      cargoLockedPackages: cargo.length,
      pnpmLockedPackages: pnpm.length,
      v86ImageInventoryBound: v86 != null,
      thirdPartyNoticesComplete: false,
      sbomComplete: false,
      unresolved: [
        'Cargo and pnpm lock inventories include build-only dependencies and do not prove binary linkage',
        'License texts and notices for the complete Rust/JavaScript/V8 transitive closure are not yet reviewed',
        ...(v86 == null ? [] : [
          'v86 Linux image SPDX does not include complete redistribution notices, SeaBIOS review, or kernel source obligations',
          'v86 image source-lock digests are recorded but do not attest the provenance of the packaged image'
        ])
      ]
    }
  }
  const packages = [
    ...cargo.map((value, index) =>
      spdxPackage(
        `SPDXRef-Cargo-${index + 1}`,
        value.name,
        value.version,
        value.source?.startsWith('registry+')
          ? `https://crates.io/api/v1/crates/${encodeURIComponent(value.name)}/${
            encodeURIComponent(value.version)
          }/download`
          : null,
        value.checksum == null ? null : { algorithm: 'SHA256', value: value.checksum },
        value.name === 'v8' && value.version === crate.version ? 'MIT' : 'NOASSERTION'
      )
    ),
    ...pnpm.map((value, index) =>
      spdxPackage(
        `SPDXRef-pnpm-${index + 1}`,
        value.name,
        value.version,
        value.tarball,
        value.checksum,
        v86 != null && value.name === 'v86' && value.version === '0.5.432' ? 'BSD-2-Clause' : 'NOASSERTION'
      )
    )
  ]
  const spdx = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `Holonomy native development ${build.version}${v86 == null ? '' : ' experimental-v86'}`,
    documentNamespace: `https://holonomy.dev/spdx/native/${build.version}/${binary.sha256}${
      v86 == null ? '' : '/experimental-v86'
    }`,
    creationInfo: { created: '1970-01-01T00:00:00Z', creators: ['Tool: Holonomy-native-release-provenance-v1'] },
    documentComment: notices.scope,
    packages,
    files: spdxFiles,
    relationships: [{
      spdxElementId: 'SPDXRef-DOCUMENT',
      relatedSpdxElement: 'SPDXRef-File-holo',
      relationshipType: 'DESCRIBES'
    }]
  }
  await writeFile(join(bundle, 'THIRD-PARTY-NOTICES.json'), json(notices))
  await writeFile(join(bundle, 'sbom.spdx.json'), json(spdx))
  return {
    files: [...included, 'THIRD-PARTY-NOTICES.json', 'sbom.spdx.json'],
    summary: {
      schemaVersion: resolvedNotices ? 2 : 1,
      cargoLockedPackages: cargo.length,
      pnpmLockedPackages: pnpm.length,
      notices: 'THIRD-PARTY-NOTICES.json',
      sbom: 'sbom.spdx.json',
      licenseFiles: included.filter(name => name.startsWith('licenses/')),
      ...(resolvedNotices ? { resolvedNoticeFiles } : {})
    }
  }
}
