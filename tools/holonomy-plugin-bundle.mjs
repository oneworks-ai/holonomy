import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { TextDecoder } from 'node:util'

import { parse } from 'acorn'

import { readHoloPluginConfig, validateHoloPluginOptions } from './holonomy-plugin-config.mjs'

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_GRAPH_BYTES = 32 * 1024 * 1024
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const TRUSTED_RUNTIME_LIBRARIES = new Set([
  '@holonomyjs/plugin-audit',
  '@holonomyjs/plugin-permission',
  'cordis'
])

const sha256 = value => createHash('sha256').update(value).digest('hex')
const canonicalJson = value => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Holo plugin config must contain finite JSON numbers')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

const dependencies = source => {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const output = []
  const stack = [ast]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node == null || typeof node !== 'object') continue
    if (
      (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' ||
        node.type === 'ExportNamedDeclaration') && typeof node.source?.value === 'string'
    ) output.push(node.source.value)
    if (node.type === 'ImportExpression' && typeof node.source?.value === 'string') output.push(node.source.value)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) stack.push(...value)
      else if (value != null && typeof value === 'object') stack.push(value)
    }
  }
  return output
}

const within = (root, target) => target === root || target.startsWith(`${root}${path.sep}`)
const safeFile = (root, target) => {
  const normalized = path.resolve(target)
  if (!within(root, normalized) || lstatSync(normalized).isSymbolicLink()) {
    throw new Error('Holo plugin module escapes its source root')
  }
  const real = realpathSync(normalized)
  if (!within(root, real) || !lstatSync(real).isFile()) {
    throw new Error('Holo plugin module is not a regular source file')
  }
  return real
}

const findPackage = (specifier, configPath) => {
  const require = createRequire(pathToFileURL(configPath))
  try {
    return require.resolve(`${specifier}/package.json`)
  } catch {
    let current = path.dirname(require.resolve(specifier))
    while (true) {
      const candidate = path.join(current, 'package.json')
      try {
        if (lstatSync(candidate).isFile()) return candidate
      } catch {
        // Continue to the package parent.
      }
      const parent = path.dirname(current)
      if (parent === current) throw new Error(`Holo plugin package manifest is unavailable: ${specifier}`)
      current = parent
    }
  }
}

const resolveSource = (entry, configPath, allowedAbsoluteRoots) => {
  if (entry.use.startsWith('file:')) throw new Error('Holo plugin file: URLs are unsupported')
  const configDirectory = path.dirname(configPath)
  const isRelative = entry.use.startsWith('./') || entry.use.startsWith('../')
  const isAbsolute = path.isAbsolute(entry.use)
  let target
  if (isRelative) target = path.resolve(configDirectory, entry.use)
  else if (isAbsolute) {
    target = path.resolve(entry.use)
    const allowed = allowedAbsoluteRoots.some(root => within(realpathSync(root), realpathSync(target)))
    if (!allowed) throw new Error(`Absolute Holo plugin source is not allowed: ${entry.id}`)
  } else target = findPackage(entry.use, configPath)
  const stat = lstatSync(target)
  if (stat.isSymbolicLink()) throw new Error('Holo plugin source must not be a symbolic link')
  if (stat.isFile() && !target.endsWith('package.json')) {
    return { entryFile: realpathSync(target), root: realpathSync(path.dirname(target)) }
  }
  const manifestFile = stat.isDirectory() ? path.join(target, 'package.json') : target
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const holo = manifest?.holo
  if (
    holo == null || typeof holo !== 'object' || holo.kind !== 'runtime-plugin' ||
    holo.apiVersion !== 1 || typeof holo.entry !== 'string'
  ) throw new Error(`Holo plugin package manifest is invalid: ${entry.id}`)
  const root = realpathSync(path.dirname(manifestFile))
  const entryFile = safeFile(root, path.resolve(root, holo.entry))
  const configSchema = holo.configSchema == null
    ? undefined
    : safeFile(root, path.resolve(root, holo.configSchema))
  return { configSchema, entryFile, root }
}

const collectFiles = (instanceId, root, entryFile) => {
  const pending = [entryFile]
  const files = new Map()
  let total = 0
  while (pending.length > 0) {
    const file = pending.pop()
    if (files.has(file)) continue
    const bytes = readFileSync(file)
    let source
    try {
      source = UTF8.decode(bytes)
    } catch {
      throw new Error('Holo plugin modules must contain strict UTF-8 source')
    }
    total += bytes.byteLength
    if (bytes.byteLength > MAX_FILE_BYTES || total > MAX_GRAPH_BYTES) {
      throw new Error('Holo plugin module graph exceeds the byte limit')
    }
    const relative = path.relative(root, file).split(path.sep).join('/')
    if (relative.startsWith('../')) throw new Error('Holo plugin module escapes its source root')
    const url = `holo-plugins:///${instanceId}/${relative}`
    files.set(file, Object.freeze({ sha256: sha256(bytes), source, url }))
    for (const specifier of dependencies(source)) {
      if (TRUSTED_RUNTIME_LIBRARIES.has(specifier)) continue
      if (!specifier.startsWith('.')) throw new Error(`Unsupported Holo plugin import: ${specifier}`)
      pending.push(safeFile(root, path.resolve(path.dirname(file), specifier)))
    }
  }
  return Object.freeze([...files.values()].sort((left, right) => left.url.localeCompare(right.url)))
}

export const prepareHolonomyRuntimePlugins = (input, options = {}) => {
  const loaded = readHoloPluginConfig(input, options)
  const allowedAbsoluteRoots = (options.allowedAbsoluteRoots ?? []).map(root => path.resolve(root))
  const bundles = loaded.plugins.filter(entry => entry.enabled).map(entry => {
    const resolved = resolveSource(entry, loaded.configPath, allowedAbsoluteRoots)
    validateHoloPluginOptions(resolved.configSchema, entry.config)
    const files = collectFiles(entry.id, resolved.root, resolved.entryFile)
    const rootUrl = `holo-plugins:///${entry.id}/`
    const relativeEntry = path.relative(resolved.root, resolved.entryFile).split(path.sep).join('/')
    const bundle = {
      config: entry.config,
      entryUrl: `${rootUrl}${relativeEntry}`,
      exportName: entry.exportName,
      files,
      instanceId: entry.id,
      rootUrl,
      schemaVersion: 1
    }
    const bundleSha256 = sha256(canonicalJson({
      ...bundle,
      files: files.map(file => ({ sha256: file.sha256, url: file.url }))
    }))
    if (entry.integrity != null && entry.integrity !== bundleSha256) {
      throw new Error(`Holo plugin integrity mismatch: ${entry.id}`)
    }
    return Object.freeze({ ...bundle, bundleSha256 })
  })
  return Object.freeze({ bundles: Object.freeze(bundles), configPath: loaded.configPath })
}
