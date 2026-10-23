import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ordered = values => [...values].sort((a, b) => a.localeCompare(b, 'en'))
const safePath = value =>
  typeof value === 'string' && value.length > 0 &&
  value.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\\'))
const assetNames = ['runtime', 'control', 'plugin-validator', 'module-planner', 'v86-web-standards']

export const writeResolvedNoticeIndex = async ({ bundle, evidence }) => {
  const names = ordered(evidence.files.keys())
  for (const name of names) {
    if (!safePath(name) || !name.startsWith('licenses/resolved/')) {
      throw new Error('Invalid resolved notice destination')
    }
    const destination = join(bundle, name)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, evidence.files.get(name))
  }
  const path = 'provenance/resolved-notice-index.json'
  await writeFile(join(bundle, path), `${JSON.stringify(evidence.index, null, 2)}\n`)
  return [path, ...names]
}

export const verifyResolvedNoticeIndex = ({ index, manifest, cargo, pnpm }) => {
  const expectedNames = manifest.engine.v86BackendCompiled ? assetNames : assetNames.slice(0, 4)
  if (
    index?.schemaVersion !== 1 || !Array.isArray(index.assets) ||
    !Array.isArray(index.cargo) || !Array.isArray(index.pnpm) ||
    !Array.isArray(index.unresolved) || index.assets.length !== expectedNames.length ||
    index.cargoFeature !== (manifest.engine.v86BackendCompiled
        ? 'holonomy-desktop-v8/v86-backend'
        : 'default')
  ) {
    throw new Error('Invalid resolved notice index')
  }
  const expectedAssets = [
    manifest.engine.runtimeAssetSha256,
    manifest.engine.hostControlAssetSha256,
    manifest.engine.pluginValidatorAssetSha256,
    manifest.engine.modulePlannerAssetSha256
  ]
  for (const [position, asset] of index.assets.entries()) {
    if (
      asset.name !== expectedNames[position] || !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
      (position < 4 && asset.sha256 !== expectedAssets[position]) ||
      !Array.isArray(asset.inputs) || asset.inputs.length === 0 ||
      asset.inputs.some(input => !safePath(input.path) || !/^[a-f0-9]{64}$/u.test(input.sha256)) ||
      JSON.stringify(asset.inputs.map(input => input.path)) !==
        JSON.stringify(ordered(new Set(asset.inputs.map(input => input.path))))
    ) {
      throw new Error('Resolved notice embedded asset graph differs')
    }
  }
  const cargoLock = new Map(cargo.map(item => [`${item.name}@${item.version}`, item]))
  const pnpmLock = new Map(pnpm.map(item => [`${item.name}@${item.version}`, item]))
  const externalInputs = new Map()
  for (const asset of index.assets) {
    for (const input of asset.inputs) {
      if (!input.path.startsWith('node_modules/')) continue
      const previous = externalInputs.get(input.path)
      if (previous && previous.sha256 !== input.sha256) throw new Error('Conflicting embedded npm input bytes')
      const row = previous ?? { sha256: input.sha256, bundles: new Set() }
      row.bundles.add(asset.name)
      externalInputs.set(input.path, row)
    }
  }
  const npmInputs = new Set()
  const noticePaths = new Set()
  for (const item of index.cargo) {
    const lock = cargoLock.get(`${item.name}@${item.version}`)
    if (
      !lock || item.source !== lock.source || item.checksum !== lock.checksum ||
      !['normal', 'build-path-only'].includes(item.reachability) ||
      (lock.checksum && item.archiveSha256 !== lock.checksum) ||
      !Array.isArray(item.notices)
    ) throw new Error('Resolved Cargo notice identity differs from lock')
    for (const notice of item.notices) {
      if (!notice.path.startsWith('licenses/resolved/cargo/')) {
        throw new Error('Invalid resolved Cargo notice path')
      }
      noticePaths.add(notice.path)
      if (
        manifest.files[notice.path]?.sha256 !== notice.sha256 ||
        manifest.files[notice.path]?.bytes !== notice.bytes
      ) {
        throw new Error('Resolved Cargo notice text differs')
      }
    }
  }
  for (const item of index.pnpm) {
    const lock = pnpmLock.get(`${item.name}@${item.version}`)
    if (
      !lock || item.tarball !== lock.tarball ||
      JSON.stringify(item.lockIntegrity) !== JSON.stringify(lock.checksum) ||
      item.sourceAssurance !== 'installed-files; npm tarball integrity not independently verified' ||
      !Array.isArray(item.inputs) || !Array.isArray(item.notices)
    ) {
      throw new Error('Resolved npm notice identity differs from lock')
    }
    const packageBundles = new Set()
    for (const input of item.inputs) {
      const embedded = externalInputs.get(input.path)
      if (
        !input.path.startsWith('node_modules/.pnpm/') ||
        !input.path.includes(`/node_modules/${item.name}/`) ||
        !/^[a-f0-9]{64}$/u.test(input.sha256) || !embedded ||
        embedded.sha256 !== input.sha256 || npmInputs.has(input.path) ||
        JSON.stringify(input.bundles) !== JSON.stringify(ordered(embedded.bundles))
      ) {
        throw new Error('Resolved npm input graph differs')
      }
      npmInputs.add(input.path)
      for (const bundle of input.bundles) packageBundles.add(bundle)
    }
    if (JSON.stringify(item.bundles) !== JSON.stringify(ordered(packageBundles))) {
      throw new Error('Resolved npm bundle membership differs')
    }
    for (const notice of item.notices) {
      if (!notice.path.startsWith('licenses/resolved/pnpm/')) {
        throw new Error('Invalid resolved npm notice path')
      }
      noticePaths.add(notice.path)
      if (
        manifest.files[notice.path]?.sha256 !== notice.sha256 ||
        manifest.files[notice.path]?.bytes !== notice.bytes
      ) {
        throw new Error('Resolved npm notice text differs')
      }
    }
  }
  if (npmInputs.size !== externalInputs.size) throw new Error('Resolved npm input graph differs')
  const expectedFiles = ['provenance/resolved-notice-index.json', ...ordered(noticePaths)]
  const expectedUnresolved = ordered([
    ...index.cargo.filter(item => item.source && item.notices.length === 0)
      .map(item => `cargo:${item.name}@${item.version}:no-verified-text`),
    ...index.pnpm.filter(item => item.notices.length === 0)
      .map(item => `pnpm:${item.name}@${item.version}:no-verified-text`)
  ])
  if (
    noticePaths.size !== index.cargo.reduce((n, item) => n + item.notices.length, 0) +
        index.pnpm.reduce((n, item) => n + item.notices.length, 0) ||
    JSON.stringify(manifest.provenance.resolvedNoticeFiles) !== JSON.stringify(expectedFiles) ||
    JSON.stringify(index.unresolved) !== JSON.stringify(expectedUnresolved)
  ) {
    throw new Error('Resolved notice file inventory differs')
  }
  return { cargoResolvedPackages: index.cargo.length, npmEmbeddedPackages: index.pnpm.length }
}
