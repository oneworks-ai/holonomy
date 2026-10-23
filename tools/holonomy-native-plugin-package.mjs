import path from 'node:path'

import { parseHoloPluginJson } from './holonomy-plugin-config.mjs'

const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024

export const within = (root, target) =>
  target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)

const packageName = use => {
  const parts = use.split('/')
  const scoped = use.startsWith('@')
  const name = scoped ? parts.slice(0, 2).join('/') : parts[0]
  if (
    parts.length !== (scoped ? 2 : 1) ||
    !/^(?:@[\w.-]+\/)?[\w.-]+$/u.test(name) ||
    name === '.' || name === '..' || parts.some(part => part === '.' || part === '..')
  ) throw new Error('Holo plugin package name is invalid')
  return name
}

export const findPackageSource = async (reader, use, configPath) => {
  const name = packageName(use)
  const configRoot = path.dirname(configPath)
  const localPackage = path.join(configRoot, 'node_modules', name)
  const localManifest = path.join(localPackage, 'package.json')
  const pinned = await reader.openPrivatePackage(configRoot, localManifest)
  if (pinned != null) return pinned
  // Keep ancestor lookup only for physical no-symlink packages. Linked
  // packages may be opened only under the selected config root.
  let current = configRoot
  for (let depth = 0; depth < 128; depth++) {
    const candidate = path.join(current, 'node_modules', name)
    const stat = await reader.statPrivate(candidate)
    if (stat.kind === 'directory') return path.join(candidate, 'package.json')
    if (stat.kind !== 'missing') throw new Error('Holo plugin package source is unavailable')
    const parent = path.dirname(current)
    if (parent === current) throw new Error('Holo plugin package manifest is unavailable')
    current = parent
  }
  throw new Error('Holo plugin package search exceeds the depth limit')
}

export const packageRootFor = (target, configPath, allowedAbsoluteRoots) =>
  [path.dirname(configPath), ...allowedAbsoluteRoots]
    .filter(root => within(root, target))
    .sort((left, right) => right.length - left.length)[0]

const packageRelativeFile = (root, requested) => {
  if (typeof requested !== 'string' || requested.length === 0 || path.isAbsolute(requested)) {
    throw new Error('Holo plugin module escapes its source root')
  }
  const file = path.resolve(root, requested)
  if (!within(root, file) || file === root) {
    throw new Error('Holo plugin module escapes its source root')
  }
  return path.relative(root, file).split(path.sep).join('/')
}

export const parsedManifest = (bytes, id, maximumBytes) => {
  const manifest = parseHoloPluginJson(bytes, 'Holo plugin package manifest', maximumBytes)
  const holo = manifest?.holo
  if (
    holo == null || typeof holo !== 'object' || Array.isArray(holo) ||
    holo.kind !== 'runtime-plugin' || holo.apiVersion !== 1 || typeof holo.entry !== 'string' ||
    (holo.configSchema != null && typeof holo.configSchema !== 'string')
  ) throw new Error(`Holo plugin package manifest is invalid: ${id}`)
  return holo
}

export const pinnedPackageSource = (entry, pinned) => {
  const holo = parsedManifest(pinned.bytes, entry.id, MAX_PACKAGE_MANIFEST_BYTES)
  const packageType = parseHoloPluginJson(pinned.bytes, 'Holo plugin package manifest', MAX_PACKAGE_MANIFEST_BYTES).type
  const root = pinned.rootPath
  const entryRelative = packageRelativeFile(root, holo.entry)
  if (entryRelative === 'package.json') {
    throw new Error('Holo plugin package manifest is not an executable module')
  }
  const schemaRelative = holo.configSchema == null
    ? undefined
    : packageRelativeFile(root, holo.configSchema)
  return {
    packageId: pinned.packageId,
    packageType,
    root,
    entryFile: path.join(root, entryRelative),
    configSchema: schemaRelative == null ? undefined : path.join(root, schemaRelative),
    schemaRelative
  }
}
