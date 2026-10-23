/* eslint-disable max-lines -- One Native collector owns both config and data-entry preparation. */
import { Buffer } from 'node:buffer'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { TextDecoder } from 'node:util'

import { runtimePluginBundleDigestV2 } from '@holonomyjs/runtime/app'
import { HolonomyModuleLoader } from '@holonomyjs/runtime/module-loader/index'
import { analyzeModuleSource } from '@holonomyjs/runtime/module-loader/source-analysis'

import {
  findPackageSource,
  packageRootFor,
  parsedManifest,
  pinnedPackageSource,
  within
} from './holonomy-native-plugin-package.mjs'
import { createRuntimePluginBundle, isTrustedRuntimePluginLibrary } from './holonomy-plugin-bundle.mjs'
import {
  normalizeHoloPluginConfig,
  parseHoloPluginJson,
  resolveHoloConfigPath,
  validateHoloPluginOptionsValue
} from './holonomy-plugin-config.mjs'

const MAX_MODULES = 512
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_GRAPH_BYTES = 32 * 1024 * 1024
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const ROOT_URL = instanceId => `holo-plugins:///${instanceId}/`

const sourceUrl = (rootUrl, rootPath, file) => {
  const relative = path.relative(rootPath, file)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Holo plugin source is outside its selected root')
  }
  return `${rootUrl}${pathToFileURL(`/${relative.split(path.sep).join('/')}`).pathname.slice(1)}`
}

const selectedSourceRoot = (entryFile, configPath, allowedAbsoluteRoots) => {
  const configRoot = path.dirname(configPath)
  if (within(configRoot, entryFile)) return configRoot
  return [...allowedAbsoluteRoots].filter(root => within(root, entryFile))
    .sort((left, right) => right.length - left.length)[0]
}

const prepareNativeGraphBundleV2 = async (
  reader,
  entry,
  resolved,
  configPath,
  allowedAbsoluteRoots,
  configSchema,
  limits
) => {
  const selectedRoot = selectedSourceRoot(resolved.entryFile, configPath, allowedAbsoluteRoots)
  if (selectedRoot == null) return null
  if (
    typeof reader.openPrivateSourceRoot !== 'function' ||
    typeof reader.readPrivateSourceResource !== 'function'
  ) return null
  const rootUrl = ROOT_URL(entry.id)
  // Bind the graph root to the same package FD that supplied holo/Schema.
  const sourceRoot = resolved.packageId == null
    ? await reader.openPrivateSourceRoot(selectedRoot, rootUrl)
    : await reader.openPrivateSourceRoot(selectedRoot, rootUrl, resolved.packageId)
  const entryUrl = sourceUrl(rootUrl, sourceRoot.rootPath, resolved.entryFile)
  const loader = new HolonomyModuleLoader({
    readModule: (url, context) => reader.readPrivateSourceResource(sourceRoot.sourceRootId, url, context?.purpose),
    syntheticNodeModules: Object.freeze(Object.create(null))
  }, {
    rootUrl,
    allowJsonModules: true,
    captureDynamicImports: true,
    resolutionProfile: 'production',
    limits: {
      maxModules: limits.maxModules,
      maxSourceBytes: limits.maxFileBytes,
      maxTotalSourceBytesPerPlan: limits.maxGraphBytes
    }
  })
  const sourceClosure = await loader.createSourceClosure(entryUrl, { isExternalModule: () => false })
  const plan = await loader.createPlan(entryUrl)
  if (plan.modules.some(module => module.format !== 'module')) {
    throw new Error(`Native Holo plugin CommonJS or JSON graph is unsupported: ${entry.id}`)
  }
  const raw = Object.freeze({
    config: entry.config,
    ...(configSchema === undefined ? {} : { configSchema }),
    entryUrl: sourceClosure.entryUrl,
    exportName: entry.exportName,
    instanceId: entry.id,
    rootUrl,
    schemaVersion: 2,
    sourceClosure
  })
  const bundleSha256 = runtimePluginBundleDigestV2(raw)
  if (entry.integrity != null && entry.integrity !== bundleSha256) {
    throw new Error(`Holo plugin integrity mismatch: ${entry.id}`)
  }
  return Object.freeze({ ...raw, bundleSha256 })
}

const requireNativeReader = reader => {
  if (
    reader == null || typeof reader.readPrivate !== 'function' ||
    typeof reader.capturePrivate !== 'function' || typeof reader.statPrivate !== 'function' ||
    typeof reader.openPrivatePackage !== 'function' ||
    typeof reader.readPrivatePackage !== 'function'
  ) throw new Error('Native source reader is required')
}

const sourceFile = async (reader, root, candidate) => {
  const file = path.resolve(candidate)
  if (!within(root, file)) throw new Error('Holo plugin module escapes its source root')
  const stat = await reader.statPrivate(file)
  if (stat.kind !== 'file') throw new Error('Holo plugin module is not a regular source file')
  return file
}

const readRequired = async (reader, file, kind, label) => {
  await reader.capturePrivate(file)
  const selected = await reader.readPrivate(file, kind)
  if (selected == null) throw new Error(`${label} is unavailable`)
  return selected
}

const resolveSource = async (reader, entry, configPath, allowedAbsoluteRoots) => {
  if (entry.use.startsWith('file:')) throw new Error('Holo plugin file: URLs are unsupported')
  const relative = entry.use.startsWith('./') || entry.use.startsWith('../')
  const absolute = path.isAbsolute(entry.use)
  let target
  if (relative) target = path.resolve(path.dirname(configPath), entry.use)
  else if (absolute) {
    target = path.resolve(entry.use)
    if (!allowedAbsoluteRoots.some(root => within(root, target))) {
      throw new Error(`Absolute Holo plugin source is not allowed: ${entry.id}`)
    }
  } else {
    const selected = await findPackageSource(reader, entry.use, configPath)
    if (typeof selected !== 'string') return pinnedPackageSource(entry, selected)
    target = selected
  }

  let stat
  try {
    stat = await reader.statPrivate(target)
  } catch (error) {
    // The strict legacy stat rejects a package-directory link. Only the Native
    // package lease may admit it, and only beneath an already allowed root.
    if (error?.code !== 'source_rejected') throw error
    const root = packageRootFor(target, configPath, allowedAbsoluteRoots)
    if (root == null) throw error
    const manifestFile = path.basename(target) === 'package.json'
      ? target
      : path.join(target, 'package.json')
    const pinned = await reader.openPrivatePackage(root, manifestFile)
    if (pinned == null) throw error
    return pinnedPackageSource(entry, pinned)
  }
  if (stat.kind === 'file' && !target.endsWith('package.json')) {
    return { entryFile: await sourceFile(reader, path.dirname(target), target), root: path.dirname(target) }
  }
  const manifestFile = stat.kind === 'directory' ? path.join(target, 'package.json') : target
  if (stat.kind === 'missing') throw new Error('Holo plugin source is unavailable')
  const root = packageRootFor(manifestFile, configPath, allowedAbsoluteRoots)
  if (root != null) {
    const pinned = await reader.openPrivatePackage(root, manifestFile)
    if (pinned != null) return pinnedPackageSource(entry, pinned)
  }
  const selected = await readRequired(reader, manifestFile, 'manifest', 'Holo plugin package manifest')
  const holo = parsedManifest(selected.bytes, entry.id, MAX_FILE_BYTES)
  const packageType = parseHoloPluginJson(selected.bytes, 'Holo plugin package manifest', MAX_FILE_BYTES).type
  const legacyRoot = path.dirname(manifestFile)
  const entryFile = await sourceFile(reader, legacyRoot, path.resolve(legacyRoot, holo.entry))
  const configSchema = holo.configSchema == null
    ? undefined
    : await sourceFile(reader, legacyRoot, path.resolve(legacyRoot, holo.configSchema))
  return { configSchema, entryFile, packageType, root: legacyRoot }
}

const collectFiles = async (reader, instanceId, resolved, limits) => {
  const { root } = resolved
  const pending = [resolved.entryFile]
  const files = new Map()
  let total = 0
  while (pending.length > 0) {
    const file = pending.pop()
    if (files.has(file)) continue
    if (files.size >= limits.maxModules) throw new Error('Holo plugin module graph exceeds the file limit')
    const relative = path.relative(root, file).split(path.sep).join('/')
    if (relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('Holo plugin module escapes its source root')
    }
    if (resolved.packageId != null && relative === 'package.json') {
      throw new Error('Holo plugin package manifest is not an executable module')
    }
    const selected = resolved.packageId == null
      ? await readRequired(reader, file, 'module', 'Holo plugin module')
      : await reader.readPrivatePackage(resolved.packageId, relative, 'module')
    if (selected == null) throw new Error('Holo plugin module is unavailable')
    const bytes = selected.bytes
    total += bytes.byteLength
    if (bytes.byteLength > limits.maxFileBytes || total > limits.maxGraphBytes) {
      throw new Error('Holo plugin module graph exceeds the byte limit')
    }
    let source
    try {
      source = UTF8.decode(bytes)
    } catch {
      throw new Error('Holo plugin modules must contain strict UTF-8 source')
    }
    const url = `holo-plugins:///${instanceId}/${relative}`
    files.set(file, Object.freeze({ sha256: selected.sha256, source, url }))
    let imports
    try {
      imports = analyzeModuleSource(source, 'module', url).dependencies
    } catch {
      throw new Error('Holo plugin module syntax is invalid')
    }
    for (const dependency of imports) {
      if (dependency.kind === 'require' || dependency.kind === 'require-resolve') {
        throw new Error('Native Holo plugin CommonJS graph is unsupported')
      }
      const specifier = dependency.specifier
      if (specifier == null) continue
      if (isTrustedRuntimePluginLibrary(specifier)) continue
      if (!specifier.startsWith('.')) return { requiresGraph: 'bare' }
      const next = path.resolve(path.dirname(file), specifier)
      if (!within(root, next)) return { requiresGraph: 'escape' }
      pending.push(resolved.packageId == null ? await sourceFile(reader, root, next) : next)
    }
  }
  return { files: Object.freeze([...files.values()].sort((left, right) => left.url.localeCompare(right.url))) }
}

// The caller retains the reader through Guest source admission and watch. This
// function neither seals nor closes it; all selected Host bytes come from the
// native reader before a Guest module is admitted.
export const prepareNativeRuntimePluginEntriesV1 = async (entries, options = {}) => {
  const { reader } = options
  requireNativeReader(reader)
  const configPath = options.configPath
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) {
    throw new Error('Native plugin config path is required')
  }
  const loaded = normalizeHoloPluginConfig({ plugins: entries }, configPath)
  const allowedAbsoluteRoots = (options.allowedAbsoluteRoots ?? []).map(root => path.resolve(root))
  const limits = Object.freeze({
    maxModules: options.limits?.maxModules ?? MAX_MODULES,
    maxFileBytes: options.limits?.maxFileBytes ?? MAX_FILE_BYTES,
    maxGraphBytes: options.limits?.maxGraphBytes ?? MAX_GRAPH_BYTES
  })
  if (
    Object.keys(options.limits ?? {}).some(key => !Object.hasOwn(limits, key)) ||
    !Number.isSafeInteger(limits.maxModules) || limits.maxModules < 1 || limits.maxModules > MAX_MODULES ||
    !Number.isSafeInteger(limits.maxFileBytes) || limits.maxFileBytes < 1 || limits.maxFileBytes > MAX_FILE_BYTES ||
    !Number.isSafeInteger(limits.maxGraphBytes) || limits.maxGraphBytes < 1 || limits.maxGraphBytes > MAX_GRAPH_BYTES
  ) throw new Error('Native plugin source limits are invalid')
  const bundles = []
  let aggregateBytes = 0
  let aggregateFiles = 0
  for (const entry of loaded.plugins) {
    if (!entry.enabled) continue
    const resolved = await resolveSource(reader, entry, configPath, allowedAbsoluteRoots)
    if (
      resolved.entryFile.endsWith('.cjs') || resolved.packageType === 'commonjs' && resolved.entryFile.endsWith('.js')
    ) {
      throw new Error(`Native Holo plugin CommonJS graph is unsupported: ${entry.id}`)
    }
    let configSchema
    if (resolved.configSchema != null) {
      const selected = resolved.packageId == null
        ? await readRequired(reader, resolved.configSchema, 'schema', 'Holo plugin config Schema')
        : await reader.readPrivatePackage(resolved.packageId, resolved.schemaRelative, 'schema')
      if (selected == null) throw new Error('Holo plugin config Schema is unavailable')
      configSchema = parseHoloPluginJson(selected.bytes, 'Holo plugin config Schema')
      try {
        validateHoloPluginOptionsValue(configSchema, entry.config)
      } catch (error) {
        if (error?.message === 'Holo plugin config does not match its Schema') throw error
        throw new Error('Holo plugin config Schema is invalid')
      }
    }
    const collected = await collectFiles(reader, entry.id, resolved, limits)
    if (collected.requiresGraph) {
      const graphBundle = await prepareNativeGraphBundleV2(
        reader,
        entry,
        resolved,
        configPath,
        allowedAbsoluteRoots,
        configSchema,
        limits
      )
      if (graphBundle == null) {
        throw new Error(
          collected.requiresGraph === 'escape'
            ? 'Holo plugin module escapes its source root'
            : 'Unsupported Holo plugin import'
        )
      }
      bundles.push(graphBundle)
      aggregateFiles += graphBundle.sourceClosure.reads.length
      aggregateBytes += graphBundle.sourceClosure.reads.reduce((total, read) => total + read.byteLength, 0)
      if (
        options.limits != null &&
        (aggregateFiles > limits.maxModules || aggregateBytes > limits.maxGraphBytes)
      ) throw new Error('Holo plugin aggregate graph exceeds its limit')
      continue
    }
    const files = collected.files
    aggregateFiles += files.length
    aggregateBytes += files.reduce((total, file) => total + Buffer.byteLength(file.source, 'utf8'), 0)
    if (
      options.limits != null &&
      (aggregateFiles > limits.maxModules || aggregateBytes > limits.maxGraphBytes)
    ) {
      throw new Error('Holo plugin aggregate graph exceeds its limit')
    }
    bundles.push(createRuntimePluginBundle(entry, resolved, configSchema, files))
  }
  return Object.freeze({ bundles: Object.freeze(bundles), configPath: loaded.configPath })
}

// The config read stays with the original caller. Data-only Host entries use
// this same Native collector and never open an alternate Node source path.
export const prepareHolonomyRuntimePluginsNative = async (input, options = {}) => {
  requireNativeReader(options.reader)
  const configPath = resolveHoloConfigPath(input, options)
  const configBytes = await readRequired(options.reader, configPath, 'config', 'Holo config')
  const config = parseHoloPluginJson(configBytes.bytes, 'Holo config')
  return await prepareNativeRuntimePluginEntriesV1(config.plugins, { ...options, configPath })
}
