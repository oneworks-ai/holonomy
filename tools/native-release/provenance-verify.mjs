import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { verifyNativeBundleInventory } from './archive.mjs'

import { NATIVE_BUNDLE_DOCUMENTS } from './documents.mjs'
import { parseCargoInventory, parsePnpmInventory } from './lock-inventory.mjs'
import { describeFile } from './manifest.mjs'
import { verifyResolvedNoticeIndex } from './resolved-notice-bundle.mjs'

const exactKeys = (value, expected) =>
  value != null && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())

const requiredFiles = (v86, resolvedNoticeFiles = []) => [
  'bin/holo',
  'DEVELOPMENT.md',
  ...Object.keys(NATIVE_BUNDLE_DOCUMENTS),
  'provenance/Cargo.lock',
  'provenance/pnpm-lock.yaml',
  'provenance/rust-toolchain.toml',
  'licenses/rusty-v8-LICENSE',
  'licenses/V8-LICENSE',
  ...resolvedNoticeFiles,
  ...(v86 == null ? [] : [
    'index.js',
    'V86-EXPERIMENTAL.md',
    'configure-v86.sh',
    'cat-example.mjs',
    'private/host-cat.json',
    'private/process-profiles.json',
    ...['seabios.bin', 'kernel.bin', 'agent.cpio', 'v86.wasm', 'agent.manifest.json', 'agent.spdx.json']
      .map(name => `private/v86-assets/${name}`),
    'licenses/v86-LICENSE',
    ...['alpine-source-v1.json', 'alpine-packages-lock-v1.json', 'alpine-kernel-lock-v1.json', 'profiles-v1.json']
      .map(name => `provenance/v86-image/${name}`)
  ]),
  'THIRD-PARTY-NOTICES.json',
  'sbom.spdx.json'
]

const validateManifestEnvelope = manifest => {
  const gates = ['signed', 'notarized', 'thirdPartyNoticesComplete', 'sbomComplete', 'publishReady']
  const verification = manifest.v86 == null
    ? ['relocatedExecution', 'pathContainsNode', 'cleanMachine']
    : ['relocatedExecution', 'pathContainsNode', 'cleanMachine', 'v86CatSmoke']
  const resolvedNoticeFiles = manifest.provenance?.schemaVersion === 2
    ? manifest.provenance.resolvedNoticeFiles
    : []
  if (
    manifest == null || typeof manifest !== 'object' ||
    manifest.schemaVersion !== 1 || manifest.product !== 'holonomy' ||
    manifest.distribution !== 'development' || manifest.target !== 'aarch64-apple-darwin' ||
    !exactKeys(manifest.releaseGates, gates) || gates.some(key => manifest.releaseGates[key] !== false) ||
    !exactKeys(manifest.verification, verification) ||
    manifest.verification.relocatedExecution !== true ||
    manifest.verification.pathContainsNode !== false ||
    manifest.verification.cleanMachine !== false ||
    (manifest.v86 == null
      ? Object.hasOwn(manifest, 'variant')
      : manifest.variant !== 'experimental-v86-process' || manifest.verification.v86CatSmoke !== true) ||
    !exactKeys(manifest.buildInputs, ['Cargo.lock', 'pnpm-lock.yaml', 'rust-toolchain.toml']) ||
    ![1, 2].includes(manifest.provenance?.schemaVersion) ||
    (manifest.provenance.schemaVersion === 2 &&
      (!Array.isArray(resolvedNoticeFiles) ||
        resolvedNoticeFiles[0] !== 'provenance/resolved-notice-index.json')) ||
    (manifest.provenance.schemaVersion === 1 && manifest.provenance.resolvedNoticeFiles != null) ||
    !exactKeys(manifest.files, requiredFiles(manifest.v86, resolvedNoticeFiles))
  ) throw new Error('Invalid native development manifest envelope or file inventory')
}

export const verifyNativeProvenance = async ({ bundle, manifest }) => {
  validateManifestEnvelope(manifest)
  await verifyNativeBundleInventory({ bundle, manifest })
  for (const [path, expected] of Object.entries(manifest.files)) {
    if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Invalid packaged file path')
    }
    const actual = await describeFile(join(bundle, path))
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`Packaged file differs from manifest: ${path}`)
    }
  }
  const notices = JSON.parse(await readFile(join(bundle, 'THIRD-PARTY-NOTICES.json'), 'utf8'))
  const spdx = JSON.parse(await readFile(join(bundle, 'sbom.spdx.json'), 'utf8'))
  const cargo = parseCargoInventory(await readFile(join(bundle, 'provenance/Cargo.lock'), 'utf8'))
  const pnpm = parsePnpmInventory(await readFile(join(bundle, 'provenance/pnpm-lock.yaml'), 'utf8'))
  if (manifest.provenance.schemaVersion === 2) {
    if (notices.resolvedNoticeIndex !== 'provenance/resolved-notice-index.json') {
      throw new Error('Invalid resolved notice index declaration')
    }
    const index = JSON.parse(await readFile(join(bundle, 'provenance/resolved-notice-index.json'), 'utf8'))
    verifyResolvedNoticeIndex({ index, manifest, cargo, pnpm })
  } else if (notices.resolvedNoticeIndex != null) {
    throw new Error('Unexpected resolved notice index')
  }
  if (
    notices.schemaVersion !== 1 || notices.coverage.thirdPartyNoticesComplete !== false ||
    notices.coverage.sbomComplete !== false || spdx.spdxVersion !== 'SPDX-2.3' ||
    cargo.length !== notices.coverage.cargoLockedPackages ||
    pnpm.length !== notices.coverage.pnpmLockedPackages ||
    spdx.packages.length !== cargo.length + pnpm.length ||
    manifest.provenance?.cargoLockedPackages !== notices.coverage.cargoLockedPackages ||
    manifest.provenance?.pnpmLockedPackages !== notices.coverage.pnpmLockedPackages ||
    !spdx.files.some(value =>
      value.fileName === './bin/holo' &&
      value.checksums?.[0]?.checksumValue === manifest.files['bin/holo'].sha256
    )
  ) throw new Error('Invalid native provenance contents')
  for (const [index, value] of cargo.entries()) {
    const item = spdx.packages[index]
    if (
      item.SPDXID !== `SPDXRef-Cargo-${index + 1}` || item.name !== value.name ||
      item.versionInfo !== value.version ||
      (value.checksum != null && item.checksums?.[0]?.checksumValue !== value.checksum)
    ) throw new Error('SPDX Cargo inventory differs from packaged lock')
  }
  for (const [index, value] of pnpm.entries()) {
    const item = spdx.packages[cargo.length + index]
    if (
      item.SPDXID !== `SPDXRef-pnpm-${index + 1}` || item.name !== value.name ||
      item.versionInfo !== value.version || item.downloadLocation !== value.tarball ||
      item.checksums?.[0]?.algorithm !== value.checksum.algorithm ||
      item.checksums?.[0]?.checksumValue !== value.checksum.value
    ) throw new Error('SPDX pnpm inventory differs from packaged lock')
  }
  const assets = {
    runtime: manifest.engine.runtimeAssetSha256,
    hostControl: manifest.engine.hostControlAssetSha256,
    pluginValidator: manifest.engine.pluginValidatorAssetSha256,
    modulePlanner: manifest.engine.modulePlannerAssetSha256
  }
  if (JSON.stringify(notices.embeddedRuntimeAssets) !== JSON.stringify(assets)) {
    throw new Error('Native embedded asset provenance differs from engine')
  }
  for (const component of notices.components) {
    if (component.licenseFile == null) continue
    if ((await describeFile(join(bundle, component.licenseFile))).sha256 !== component.licenseFileSha256) {
      throw new Error('Native third-party notice text differs from record')
    }
  }
  for (const [name, expected] of Object.entries(notices.sourceInputs)) {
    if (manifest.buildInputs[name]?.sha256 !== expected) throw new Error('Native provenance lock digest differs')
    if ((await describeFile(join(bundle, 'provenance', name))).sha256 !== expected) {
      throw new Error('Packaged native lock digest differs from notices')
    }
  }
  if (
    Object.values(manifest.releaseGates).some(value => value !== false) ||
    manifest.verification.cleanMachine !== false
  ) throw new Error('Development artifact cannot be publish ready')
  if (manifest.v86 != null) {
    const component = notices.components.find(value => value.name === 'v86')
    const npmV86 = pnpm.find(value => value.name === 'v86' && value.version === '0.5.432')
    if (
      component == null || npmV86 == null ||
      component.npmIntegrity.algorithm !== npmV86.checksum.algorithm ||
      component.npmIntegrity.value !== npmV86.checksum.value ||
      component.linuxImageSpdx.sha256 !== manifest.files['private/v86-assets/agent.spdx.json']?.sha256 ||
      component.embeddedAssets['v86.wasm'].sha256 !==
        manifest.v86.sourceAssetInputs['adapters/desktop/v8-host/assets/v86.wasm'].sha256 ||
      component.embeddedAssets['libv86.js'].sha256 !==
        manifest.v86.sourceAssetInputs['adapters/desktop/v8-host/assets/libv86.js'].sha256
    ) throw new Error('v86 embedded asset provenance differs from manifest')
    for (const [name, expected] of Object.entries(component.linuxImageSourceLocks)) {
      if ((await describeFile(join(bundle, 'provenance/v86-image', name))).sha256 !== expected.sha256) {
        throw new Error('v86 source lock differs from notices')
      }
    }
  } else if (notices.components.some(value => value.name === 'v86')) {
    throw new Error('Default artifact contains v86 provenance')
  }
  return {
    cargoLockedPackages: notices.coverage.cargoLockedPackages,
    pnpmLockedPackages: notices.coverage.pnpmLockedPackages
  }
}
