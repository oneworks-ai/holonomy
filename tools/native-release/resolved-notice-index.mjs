import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { open, readFile, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { collectEmbeddedInputs } from './resolved-notice-assets.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const ordered = values => [...values].sort((a, b) => a.localeCompare(b, 'en'))
const noticeName = name =>
  /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[-_.][^/]+)?$/iu.test(name) &&
  !/\.(?:rs|c|cc|cpp|h|hpp|js|ts|mjs|py|sh)$/iu.test(name)
const safePath = value =>
  typeof value === 'string' && value.length > 0 &&
  value.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\\'))
const command = (binary, args, cwd, maxBuffer = 16 * 1024 * 1024, input = null) => {
  const result = spawnSync(binary, args, { cwd, encoding: null, input, maxBuffer, timeout: 30_000 })
  if (result.error || result.status !== 0) {
    throw new Error(`Native notice source command failed: ${binary} ${args[0]}`)
  }
  return result.stdout
}
export const parseCargoTree = source => {
  const packages = new Map()
  for (const raw of source.trim().split('\n')) {
    const line = raw.trim().replace(/ \(\*\)$/u, '')
    const match = line.match(/^(.+) v([^ ]+)(?: \((.+)\))?$/u)
    if (!match) throw new Error(`Invalid Cargo tree package: ${line}`)
    const [, name, version, location] = match
    packages.set(`${name}@${version}`, { name, version, workspace: location?.startsWith('/') ?? false })
  }
  return [...packages.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en')
  )
}
const cargoTrees = (root, featureCompiled) => {
  const base = [
    'tree',
    '--locked',
    '--offline',
    '--target',
    'aarch64-apple-darwin',
    '-p',
    'holonomy-cli',
    '--prefix',
    'none',
    '--format',
    '{p}'
  ]
  if (featureCompiled) base.push('--features', 'holonomy-desktop-v8/v86-backend')
  const read = edges => parseCargoTree(command('cargo', [...base, '--edges', edges], root).toString('utf8'))
  return { normal: read('normal'), all: read('normal,build') }
}

const crateArchive = async (cargoHome, name, version, expected) => {
  const cache = join(cargoHome, 'registry/cache')
  for (const registry of ordered(await readdir(cache))) {
    const candidate = join(cache, registry, `${name}-${version}.crate`)
    if (!existsSync(candidate)) continue
    const bytes = await readFile(candidate)
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Locked Cargo crate archive exceeds notice bound')
    if (digest(bytes) === expected) return bytes
  }
  throw new Error(`Locked Cargo crate archive unavailable or changed: ${name}@${version}`)
}
const tarNotices = (archive, name, version) => {
  const prefix = `${name}-${version}/`
  return ordered(
    command('/usr/bin/tar', ['-tzf', '-'], undefined, 16 * 1024 * 1024, archive).toString('utf8')
      .trim().split('\n').filter(path => path.startsWith(prefix))
      .filter(path => safePath(path) && noticeName(path.slice(path.lastIndexOf('/') + 1)))
  )
    .map(path => ({ sourcePath: path, relative: path.slice(prefix.length) }))
}

const addText = (files, path, bytes) => {
  if (!safePath(path) || bytes.length === 0 || bytes.length > 256 * 1024 || files.has(path)) {
    throw new Error(`Invalid or duplicate native notice text: ${path}`)
  }
  files.set(path, bytes)
  return { path, bytes: bytes.length, sha256: digest(bytes) }
}
export const readPackageLeaf = async (root, packageRoot, leaf, maximum) => {
  root = resolve(root)
  const packagePath = join(root, packageRoot)
  if (
    !packageRoot.startsWith('node_modules/.pnpm/') ||
    await realpath(root) !== root || await realpath(packagePath) !== packagePath ||
    !safePath(leaf)
  ) throw new Error('Invalid installed npm package root')
  const file = await open(join(packagePath, leaf), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) {
      throw new Error('Invalid installed npm package text')
    }
    const bytes = await file.readFile()
    if (bytes.length !== stat.size) throw new Error('Installed npm package text changed')
    return bytes
  } finally {
    await file.close()
  }
}

export const collectResolvedNoticeIndex = async ({
  root,
  cargo,
  pnpm,
  engine,
  cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo'),
  trees = null
}) => {
  const files = new Map()
  const unresolved = []
  const resolved = trees ?? cargoTrees(root, engine.v86BackendCompiled)
  const normal = new Set(resolved.normal.map(item => `${item.name}@${item.version}`))
  const lockedCargo = new Map(cargo.map(item => [`${item.name}@${item.version}`, item]))
  const crates = []
  for (const item of resolved.all) {
    const key = `${item.name}@${item.version}`
    const lock = lockedCargo.get(key)
    if (!lock) throw new Error(`Resolved Cargo package absent from lock: ${key}`)
    const record = {
      name: item.name,
      version: item.version,
      reachability: normal.has(key) ? 'normal' : 'build-path-only',
      source: lock.source,
      checksum: lock.checksum,
      notices: []
    }
    if (lock.source?.startsWith('registry+')) {
      const archive = await crateArchive(cargoHome, item.name, item.version, lock.checksum)
      record.archiveSha256 = lock.checksum
      for (const notice of tarNotices(archive, item.name, item.version)) {
        const bytes = command('/usr/bin/tar', ['-xOzf', '-', notice.sourcePath], undefined, 300 * 1024, archive)
        const path = `licenses/resolved/cargo/${encodeURIComponent(key)}/${notice.relative}`
        record.notices.push({ sourcePath: notice.sourcePath, ...addText(files, path, bytes) })
      }
    }
    if (record.notices.length === 0 && lock.source) unresolved.push(`cargo:${key}:no-verified-text`)
    crates.push(record)
  }
  const { assets, npm } = await collectEmbeddedInputs(root, engine)
  const lockedPnpm = new Map(pnpm.map(item => [`${item.name}@${item.version}`, item]))
  const packages = []
  for (const item of [...npm.values()].sort((a, b) => a.root.localeCompare(b.root, 'en'))) {
    const descriptor = await readPackageLeaf(root, item.root, 'package.json', 64 * 1024)
    const identity = JSON.parse(descriptor)
    const key = `${identity.name}@${identity.version}`
    const lock = lockedPnpm.get(key)
    if (!lock) throw new Error(`Embedded npm package absent from lock: ${key}`)
    const record = {
      name: identity.name,
      version: identity.version,
      lockIntegrity: lock.checksum,
      tarball: lock.tarball,
      installedPackageJsonSha256: digest(descriptor),
      sourceAssurance: 'installed-files; npm tarball integrity not independently verified',
      bundles: ordered(item.bundles),
      inputs: ordered(item.inputs.keys()).map(path => ({
        path,
        sha256: item.inputs.get(path).sha256,
        bundles: ordered(item.inputs.get(path).bundles)
      })),
      notices: []
    }
    for (const name of ordered(await readdir(join(root, item.root)))) {
      if (!noticeName(name)) continue
      const bytes = await readPackageLeaf(root, item.root, name, 256 * 1024)
      const path = `licenses/resolved/pnpm/${encodeURIComponent(key)}/${name}`
      record.notices.push({ sourcePath: `${item.root}/${name}`, ...addText(files, path, bytes) })
    }
    if (record.notices.length === 0) unresolved.push(`pnpm:${key}:no-verified-text`)
    packages.push(record)
  }
  return {
    index: {
      schemaVersion: 1,
      scope:
        'Resolved input evidence for a development artifact; candidate texts are not license conclusions or binary linkage proof',
      cargoFeature: engine.v86BackendCompiled ? 'holonomy-desktop-v8/v86-backend' : 'default',
      assets,
      cargo: crates,
      pnpm: packages,
      unresolved: ordered(unresolved)
    },
    files
  }
}
