import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export const describeFile = async path => {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Artifact inputs must be regular files')
  const bytes = await readFile(path)
  return { bytes: bytes.length, sha256: sha256(bytes) }
}

export const validateEngineInfo = (info, expected, { v86BackendCompiled = false } = {}) => {
  const keys = [
    'engine',
    'rustyV8',
    'v8',
    'runtimeAssetSha256',
    'hostControlAssetSha256',
    'pluginValidatorAssetSha256',
    'modulePlannerAssetSha256',
    'v86BackendCompiled',
    'nodeInstalledRequired',
    'platform',
    'arch'
  ]
  if (
    !info || typeof info !== 'object' || Object.keys(info).length !== keys.length ||
    keys.some(key => !Object.hasOwn(info, key))
  ) {
    throw new Error('Unexpected native engine descriptor')
  }
  if (
    info.engine !== 'embedded-v8' || info.nodeInstalledRequired !== false ||
    info.v86BackendCompiled !== v86BackendCompiled || info.platform !== 'macos' ||
    info.arch !== 'aarch64'
  ) {
    throw new Error('Only the verified macOS arm64 standalone target can be packaged')
  }
  if (typeof info.v8 !== 'string' || !/^[\w.+-]{1,80}$/u.test(info.v8) || info.rustyV8 !== expected.rustyV8) {
    throw new Error('Engine version does not match the source lock')
  }
  for (
    const key of [
      'runtimeAssetSha256',
      'hostControlAssetSha256',
      'pluginValidatorAssetSha256',
      'modulePlannerAssetSha256'
    ]
  ) {
    if (!/^[a-f0-9]{64}$/u.test(info[key]) || info[key] !== expected[key]) {
      throw new Error('Binary contains stale Runtime assets; rebuild it')
    }
  }
  return Object.freeze({ ...info })
}

export const readBuildInputs = async root => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(manifest.version)) {
    throw new Error('Invalid package version')
  }
  const workspace = await readFile(join(root, 'Cargo.toml'), 'utf8')
  const rustyV8 = workspace.match(/^v8 = "=([\d.]+)"$/mu)?.[1]
  if (!rustyV8) throw new Error('Missing exact rusty_v8 pin')
  const inputs = {}
  for (const path of ['Cargo.lock', 'pnpm-lock.yaml', 'rust-toolchain.toml']) {
    inputs[path] = await describeFile(join(root, path))
  }
  const asset = async name => {
    const path = join(root, 'adapters/desktop/v8-host/generated', name)
    const bytes = await readFile(`${path}.js`)
    const digest = sha256(bytes)
    if ((await readFile(`${path}.sha256`, 'utf8')).trim() !== digest) {
      throw new Error('Generated Runtime asset digest is invalid')
    }
    return digest
  }
  return {
    version: manifest.version,
    inputs,
    expected: {
      rustyV8,
      runtimeAssetSha256: await asset('runtime'),
      hostControlAssetSha256: await asset('control'),
      pluginValidatorAssetSha256: await asset('plugin-validator'),
      modulePlannerAssetSha256: await asset('module-planner')
    }
  }
}

export const createManifest = ({ version, engine, inputs, files, provenance, v86 = null, v86CatSmoke = false }) => ({
  schemaVersion: 1,
  product: 'holonomy',
  version,
  distribution: 'development',
  target: 'aarch64-apple-darwin',
  engine,
  buildInputs: inputs,
  files,
  ...(provenance == null ? {} : { provenance }),
  ...(v86 == null ? {} : { variant: 'experimental-v86-process', v86 }),
  verification: {
    relocatedExecution: true,
    pathContainsNode: false,
    cleanMachine: false,
    ...(v86 == null ? {} : { v86CatSmoke })
  },
  releaseGates: {
    signed: false,
    notarized: false,
    thirdPartyNoticesComplete: false,
    sbomComplete: false,
    publishReady: false
  }
})
