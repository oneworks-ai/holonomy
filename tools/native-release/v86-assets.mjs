import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'

import { sha256 } from './manifest.mjs'

export const V86_ASSET_NAMES = Object.freeze([
  'seabios.bin',
  'kernel.bin',
  'agent.cpio',
  'v86.wasm'
])
const METADATA_NAMES = Object.freeze(['agent.manifest.json', 'agent.spdx.json'])
const MAX_FILE_BYTES = 128 * 1024 * 1024

const exactKeys = (value, keys, label) => {
  if (
    value == null || Array.isArray(value) || typeof value !== 'object' ||
    Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key))
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)

// Read the bytes that will be copied, through the same nofollow descriptor used
// for ownership and size checks. The Rust installer independently rechecks the
// packaged asset bytes before creating a VM.
export const readOwnedFile = async (path, { maximum = MAX_FILE_BYTES, ownerOnly = false } = {}) => {
  if (!isAbsolute(path) || await realpath(path) !== path) {
    throw new Error('Input path must be absolute and free of symlink aliases')
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() || stat.size < 1 || stat.size > maximum ||
      stat.uid !== process.getuid() ||
      (stat.mode & (ownerOnly ? 0o077 : 0o022)) !== 0
    ) {
      throw new Error('Input must be a bounded owner-controlled regular file')
    }
    const buffer = await file.readFile()
    if (buffer.length !== stat.size) throw new Error('Input changed while reading')
    return { buffer, description: { bytes: buffer.length, sha256: sha256(buffer) } }
  } finally {
    await file.close()
  }
}

const checkAssetRoot = async root => {
  if (!isAbsolute(root) || await realpath(root) !== root) {
    throw new Error('v86 asset root must be an absolute canonical path')
  }
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const stat = await directory.stat()
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) {
      throw new Error('v86 asset root must be owner controlled')
    }
  } finally {
    await directory.close()
  }
}

export const readPinnedV86Assets = async ({ root, pinsFile, sourceRoot }) => {
  await checkAssetRoot(root)
  const pinInput = await readOwnedFile(pinsFile, { maximum: 8192, ownerOnly: true })
  const pinDocument = exactKeys(
    JSON.parse(pinInput.buffer.toString('utf8')),
    ['schemaVersion', 'assets'],
    'v86 pin document'
  )
  if (pinDocument.schemaVersion !== 1) throw new Error('Invalid v86 pin version')
  const pins = exactKeys(pinDocument.assets, V86_ASSET_NAMES, 'v86 asset pins')
  if (V86_ASSET_NAMES.some(name => !digest(pins[name]))) throw new Error('Invalid v86 asset digest')

  const files = {}
  for (const name of [...V86_ASSET_NAMES, ...METADATA_NAMES]) {
    files[name] = await readOwnedFile(join(root, name), {
      maximum: name.endsWith('.json') ? 256 * 1024 : MAX_FILE_BYTES
    })
    if (pins[name] && files[name].description.sha256 !== pins[name]) {
      throw new Error(`v86 asset digest mismatch: ${name}`)
    }
  }
  if (V86_ASSET_NAMES.reduce((total, name) => total + files[name].description.bytes, 0) > 192 * 1024 * 1024) {
    throw new Error('v86 assets exceed the native aggregate byte limit')
  }
  const agent = JSON.parse(files['agent.manifest.json'].buffer.toString('utf8'))
  if (
    agent?.schemaVersion !== 1 || agent.architecture !== 'linux-x86-32' ||
    agent.profileId !== 'agent' || agent?.artifact?.name !== 'agent.cpio' ||
    agent.artifact.sha256 !== pins['agent.cpio'] ||
    agent.artifact.size !== files['agent.cpio'].description.bytes ||
    agent?.sbom?.name !== 'agent.spdx.json' ||
    agent.sbom.sha256 !== files['agent.spdx.json'].description.sha256 ||
    agent.sbom.size !== files['agent.spdx.json'].description.bytes
  ) {
    throw new Error('v86 agent manifest does not bind its image and SPDX inventory')
  }
  const spdx = JSON.parse(files['agent.spdx.json'].buffer.toString('utf8'))
  if (
    spdx?.spdxVersion !== 'SPDX-2.3' || spdx.SPDXID !== 'SPDXRef-DOCUMENT' ||
    spdx.documentNamespace !== `https://holonomy.dev/spdx/v86/agent/${pins['agent.cpio']}` ||
    !Number.isSafeInteger(agent.packageCount) || agent.packageCount < 1 ||
    !Array.isArray(spdx.packages) || spdx.packages.length !== agent.packageCount ||
    new Set(spdx.packages.map(value => value.SPDXID)).size !== agent.packageCount ||
    spdx.packages.some(value =>
      typeof value.name !== 'string' || !value.name ||
      typeof value.versionInfo !== 'string' || !value.versionInfo ||
      typeof value.licenseDeclared !== 'string' || !value.licenseDeclared
    )
  ) {
    throw new Error('v86 agent SPDX content does not match image manifest')
  }
  const embeddedWasm = await readOwnedFile(join(sourceRoot, 'adapters/desktop/v8-host/assets/v86.wasm'))
  if (embeddedWasm.description.sha256 !== pins['v86.wasm']) {
    throw new Error('v86 Wasm pin differs from the build input')
  }
  const embeddedSource = await readOwnedFile(join(sourceRoot, 'adapters/desktop/v8-host/assets/libv86.js'))
  return {
    files,
    manifest: {
      cargoFeature: 'holonomy-desktop-v8/v86-backend',
      enabledByDefault: false,
      privateProcessGate: '--experimental-v86-process',
      pinsSha256: pinInput.description.sha256,
      assets: Object.fromEntries(V86_ASSET_NAMES.map(name => [name, files[name].description])),
      agentManifest: files['agent.manifest.json'].description,
      agentSpdxInventory: files['agent.spdx.json'].description,
      sourceAssetInputs: {
        'adapters/desktop/v8-host/assets/v86.wasm': embeddedWasm.description,
        'adapters/desktop/v8-host/assets/libv86.js': embeddedSource.description
      },
      supportBoundary: 'First root process exec only; Guest descendant fork/exec is denied'
    }
  }
}
