/* eslint-disable max-lines -- the loader keeps resolution and its caches under one state owner. */
import { HolonomyModuleLoaderError, RequireEsmError } from './errors.js'
import { sha256Hex } from './sha256.js'
import { analyzeModuleSource } from './source-analysis.js'
import { DEFAULT_HOLONOMY_MODULE_LOADER_LIMITS } from './types.js'
import type {
  CreateModulePlanOptions,
  HolonomyModuleLoaderLimits,
  HolonomyModuleLoaderOptions,
  HostModuleLoaderPort,
  HostModuleReadContext,
  ModuleDependency,
  ModuleDependencyInterop,
  ModuleEvaluationCacheEntry,
  ModulePlan,
  ModuleRequireCache,
  ModuleResolutionMode,
  PlannedModule,
  PlannedModuleFormat,
  PlannedRequire
} from './types.js'

const DEFAULT_IMPORT_CONDITIONS = [
  'import',
  'module',
  'default'
] as const
const DEFAULT_REQUIRE_CONDITIONS = [
  'require',
  'default'
] as const
const SOURCE_IMPORT_CONDITIONS = [
  '__oneworks__',
  'source',
  ...DEFAULT_IMPORT_CONDITIONS
] as const
const SOURCE_REQUIRE_CONDITIONS = [
  '__oneworks__',
  'source',
  'require',
  'default'
] as const
const HEX_SHA256 = /^[\da-f]{64}$/u
const SCHEME = /^[A-Z][+\-.\dA-Z]*:/iu
const SYNTHETIC_SCHEME = /^(?:holo|node):/u
const LIMIT_KEYS = [
  'maxAstDepth',
  'maxAstNodes',
  'maxDependenciesPerModule',
  'maxModules',
  'maxSourceBytes',
  'maxTotalSourceBytesPerPlan'
] as const satisfies readonly (keyof HolonomyModuleLoaderLimits)[]
const LIMIT_KEY_SET = new Set<string>(LIMIT_KEYS)

interface VerifiedSource {
  byteLength: number
  sha256: string
  source: string
}

interface PackageManifest {
  exports?: unknown
  main?: unknown
  module?: unknown
  type?: unknown
}

interface ParsedPackage {
  manifest: PackageManifest
  rootUrl: string
  type: 'commonjs' | 'module'
}

interface MutablePlannedModule {
  dependencies: ModuleDependency[]
  exportNames: readonly string[]
  format: PlannedModuleFormat
  sha256: string | null
  source: string | null
  url: string
}

interface LoaderTransaction {
  readonly moduleKeys: Set<string>
  readonly moduleUrls: Set<string>
  readonly negativeSourceKeys: Set<string>
  readonly packageKeys: Set<string>
  readonly resolutionKeys: Set<string>
  readonly sourceBytes: Map<string, number>
  readonly sourceKeys: Set<string>
  totalSourceBytes: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value != null && typeof value === 'object' && !Array.isArray(value)
)

const normalizeDigest = (value: string) => {
  return HEX_SHA256.test(value) ? value : undefined
}

const unique = <T>(values: readonly T[]) => [...new Set(values)]

const invalidLimits = () =>
  new HolonomyModuleLoaderError(
    'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED',
    'Holonomy module limits must be a plain object containing only enumerable data properties'
  )

const snapshotLimits = (
  value: Partial<HolonomyModuleLoaderLimits> | undefined
): Readonly<HolonomyModuleLoaderLimits> => {
  let descriptors: PropertyDescriptorMap
  try {
    if (value == null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
      if (value === undefined) return DEFAULT_HOLONOMY_MODULE_LOADER_LIMITS
      throw invalidLimits()
    }
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch (error) {
    if (error instanceof HolonomyModuleLoaderError) throw error
    throw invalidLimits()
  }

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !LIMIT_KEY_SET.has(key)) throw invalidLimits()
    const descriptor = descriptors[key]
    if (descriptor == null || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw invalidLimits()
    }
  }

  const resolved = Object.fromEntries(LIMIT_KEYS.map((key) => {
    const descriptor = descriptors[key]
    const limit = descriptor == null ? DEFAULT_HOLONOMY_MODULE_LOADER_LIMITS[key] : descriptor.value
    if (!Number.isSafeInteger(limit) || limit <= 0) throw invalidLimits()
    return [key, limit]
  })) as unknown as HolonomyModuleLoaderLimits
  return Object.freeze(resolved)
}

const toDirectoryUrl = (url: URL) => {
  const directory = new URL(url.toString())
  directory.search = ''
  directory.hash = ''
  if (!directory.pathname.endsWith('/')) {
    directory.pathname = directory.pathname.slice(0, directory.pathname.lastIndexOf('/') + 1)
  }
  return directory
}

const parentDirectoryUrl = (url: URL) => {
  const parent = new URL('../', url)
  parent.search = ''
  parent.hash = ''
  return parent
}

const pathExtension = (url: string) => {
  const pathname = new URL(url).pathname
  const fileName = pathname.slice(pathname.lastIndexOf('/') + 1)
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex < 0 ? '' : fileName.slice(dotIndex).toLowerCase()
}

const withPathSuffix = (url: URL, suffix: string) => {
  const candidate = new URL(url.toString())
  candidate.pathname += suffix
  return candidate.toString()
}

const interopForFormat = (format: PlannedModuleFormat): ModuleDependencyInterop => {
  if (format === 'commonjs') return 'commonjs-namespace'
  if (format === 'synthetic') return 'synthetic-namespace'
  return 'module-namespace'
}

const compareExportPattern = (left: string, right: string) => {
  const leftWildcard = left.indexOf('*')
  const rightWildcard = right.indexOf('*')
  const leftPrefix = leftWildcard < 0 ? left.length : leftWildcard
  const rightPrefix = rightWildcard < 0 ? right.length : rightWildcard
  if (leftPrefix !== rightPrefix) return rightPrefix - leftPrefix
  const leftSuffix = leftWildcard < 0 ? 0 : left.length - leftWildcard - 1
  const rightSuffix = rightWildcard < 0 ? 0 : right.length - rightWildcard - 1
  return rightSuffix - leftSuffix || right.length - left.length
}

const matchExportPattern = (pattern: string, key: string) => {
  const wildcard = pattern.indexOf('*')
  if (wildcard < 0) return undefined
  const prefix = pattern.slice(0, wildcard)
  const suffix = pattern.slice(wildcard + 1)
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return undefined
  return key.slice(prefix.length, key.length - suffix.length)
}

const splitPackageSpecifier = (specifier: string) => {
  if (
    specifier === '' || specifier.includes('\\') || specifier.includes('\0') ||
    specifier.includes('%') || specifier.startsWith('#')
  ) {
    return undefined
  }
  const segments = specifier.split('/')
  const packageSegmentCount = specifier.startsWith('@') ? 2 : 1
  if (
    segments.length < packageSegmentCount ||
    segments.slice(0, packageSegmentCount).some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    return undefined
  }
  return {
    exportKey: segments.length === packageSegmentCount
      ? '.'
      : `./${segments.slice(packageSegmentCount).join('/')}`,
    packageName: segments.slice(0, packageSegmentCount).join('/')
  }
}

const selectExportEntry = (exportsValue: unknown, exportKey: string) => {
  if (!isRecord(exportsValue) || Array.isArray(exportsValue)) {
    return exportKey === '.' ? { entry: exportsValue, pattern: undefined } : undefined
  }
  const keys = Object.keys(exportsValue)
  const hasSubpathKeys = keys.some(key => key.startsWith('.'))
  if (!hasSubpathKeys) {
    return exportKey === '.' ? { entry: exportsValue, pattern: undefined } : undefined
  }
  if (Object.hasOwn(exportsValue, exportKey)) {
    return { entry: exportsValue[exportKey], pattern: undefined }
  }
  const match = keys
    .filter(key => key.startsWith('./') && key.includes('*'))
    .map(key => ({ key, pattern: matchExportPattern(key, exportKey) }))
    .filter((value): value is { key: string; pattern: string } => value.pattern != null)
    .sort((left, right) => compareExportPattern(left.key, right.key))[0]
  return match == null
    ? undefined
    : { entry: exportsValue[match.key], pattern: match.pattern }
}

const selectConditionalTarget = (
  value: unknown,
  conditions: readonly string[],
  pattern: string | undefined,
  depth = 0
): string | undefined => {
  if (depth > 16 || value == null) return undefined
  if (typeof value === 'string') {
    return pattern == null ? value : value.replaceAll('*', pattern)
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const selected = selectConditionalTarget(item, conditions, pattern, depth + 1)
      if (selected != null) return selected
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  for (const condition of conditions) {
    if (!Object.hasOwn(value, condition)) continue
    const selected = selectConditionalTarget(value[condition], conditions, pattern, depth + 1)
    if (selected != null) return selected
  }
  return undefined
}

export class HolonomyModuleLoader {
  readonly limits: Readonly<HolonomyModuleLoaderLimits>
  readonly rootUrl: string

  private readonly allowJsonModules: boolean
  private readonly evaluationCache = new Map<string, ModuleEvaluationCacheEntry>()
  private readonly expectedIntegrity = new Map<string, string>()
  private readonly hostReadContext: HostModuleReadContext
  private readonly importConditions: readonly string[]
  private readonly moduleCache = new Map<string, MutablePlannedModule>()
  private readonly negativeSourceCache = new Set<string>()
  private readonly packageCache = new Map<string, ParsedPackage | null>()
  private readonly port: HostModuleLoaderPort
  private readonly requireConditions: readonly string[]
  private readonly resolutionCache = new Map<string, string>()
  private readonly sourceCache = new Map<string, VerifiedSource>()
  private activeTransaction: LoaderTransaction | undefined
  private invokingHostPort = false
  private readonly reentrantHostErrors = new WeakSet<object>()
  private transactionTail: Promise<void> = Promise.resolve()

  constructor(port: HostModuleLoaderPort, options: HolonomyModuleLoaderOptions) {
    this.port = port
    this.rootUrl = this.normalizeRootUrl(options.rootUrl)
    this.allowJsonModules = options.allowJsonModules === true
    this.limits = snapshotLimits(options.limits)
    const rejectHostReentry = () => this.rejectReentrantHostCall()
    this.hostReadContext = Object.freeze({
      loader: Object.freeze({
        createPlan: rejectHostReentry,
        load: rejectHostReentry,
        resolve: rejectHostReentry
      })
    })
    const sourceProfile = options.resolutionProfile === 'source'
    this.importConditions = sourceProfile ? SOURCE_IMPORT_CONDITIONS : DEFAULT_IMPORT_CONDITIONS
    this.requireConditions = sourceProfile ? SOURCE_REQUIRE_CONDITIONS : DEFAULT_REQUIRE_CONDITIONS

    for (const [url, digest] of Object.entries(options.integrity ?? {})) {
      const canonicalUrl = this.canonicalizeModuleUrl(url, this.rootUrl, false)
      const normalizedDigest = normalizeDigest(digest)
      if (normalizedDigest == null) {
        throw new HolonomyModuleLoaderError(
          'ERR_HOLONOMY_MODULE_INTEGRITY',
          `Invalid trusted SHA-256 digest for ${canonicalUrl}`,
          { url: canonicalUrl }
        )
      }
      this.expectedIntegrity.set(canonicalUrl, normalizedDigest)
    }
  }

  async resolve(
    specifier: string,
    parentUrl = new URL('__entry__.mjs', this.rootUrl).toString(),
    mode: ModuleResolutionMode = 'import'
  ): Promise<string> {
    this.assertPublicAdmissionAllowed()
    return this.runTransaction(transaction =>
      this.resolveInternal(
        specifier,
        parentUrl,
        mode,
        transaction
      )
    )
  }

  private async resolveInternal(
    specifier: string,
    parentUrl: string,
    mode: ModuleResolutionMode,
    transaction: LoaderTransaction
  ): Promise<string> {
    if (specifier === '' || specifier.trim() !== specifier || specifier.includes('\0')) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INVALID_URL',
        `Invalid module specifier: ${JSON.stringify(specifier)}`,
        { specifier }
      )
    }
    const canonicalParent = this.canonicalizeModuleParent(parentUrl)
    const resolutionKey = this.resolutionKey(canonicalParent, mode, specifier)
    const cached = this.resolutionCache.get(resolutionKey)
    if (cached != null) return cached
    let resolvedUrl: string
    if (this.port.syntheticNodeModules[specifier] != null || SYNTHETIC_SCHEME.test(specifier)) {
      resolvedUrl = this.resolveSynthetic(specifier)
      return this.publishResolution(transaction, resolutionKey, resolvedUrl)
    }
    if (specifier.startsWith('.') || specifier.startsWith('/') || SCHEME.test(specifier)) {
      const url = this.canonicalizeModuleUrl(specifier, canonicalParent, false)
      resolvedUrl = await this.resolveExistingModuleUrl(url, transaction)
    } else {
      resolvedUrl = await this.resolvePackage(specifier, canonicalParent, mode, transaction)
    }
    return this.publishResolution(transaction, resolutionKey, resolvedUrl)
  }

  resolveResource(specifier: string, parentUrl: string): string {
    this.assertPublicAdmissionAllowed()
    const canonicalParent = this.canonicalizeModuleParent(parentUrl)
    if (
      specifier === '' || specifier.includes('\0') || specifier.includes('\\') ||
      (!specifier.startsWith('.') && !specifier.startsWith('/') && !SCHEME.test(specifier))
    ) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INVALID_URL',
        `Resource URL must be root-relative, module-relative, or absolute: ${specifier}`,
        { specifier }
      )
    }
    return this.canonicalizeModuleUrl(specifier, canonicalParent, true)
  }

  async createPlan(entrySpecifier: string, options: CreateModulePlanOptions = {}): Promise<ModulePlan> {
    this.assertPublicAdmissionAllowed()
    return this.runTransaction(async (transaction) => {
      const entryUrl = await this.resolveInternal(
        entrySpecifier,
        options.parentUrl ?? new URL('__entry__.mjs', this.rootUrl).toString(),
        options.mode ?? 'import',
        transaction
      )
      await this.loadModule(entryUrl, transaction)
      const reachable = this.collectReachableModules(entryUrl)
      return {
        entryUrl,
        modules: [...reachable]
          .sort()
          .map(url => this.snapshotModule(this.moduleCache.get(url))),
        rootUrl: this.rootUrl
      }
    })
  }

  /** Loads one already-resolved canonical URL for an engine module callback. */
  async load(canonicalUrl: string): Promise<PlannedModule> {
    this.assertPublicAdmissionAllowed()
    return this.runTransaction(async (transaction) => {
      const url = this.canonicalizeCachedModuleUrl(canonicalUrl)
      return this.snapshotModule(await this.loadModule(url, transaction))
    })
  }

  createRequire(parentUrl: string): PlannedRequire {
    this.assertSynchronousCacheAccess()
    const canonicalParent = this.canonicalizeModuleParent(parentUrl)
    const cache: ModuleRequireCache = {
      delete: (url) => {
        this.assertSynchronousCacheAccess()
        return this.deleteRequireCache(url)
      },
      get: (url) => {
        this.assertSynchronousCacheAccess()
        return this.getRequireCacheEntry(url)
      },
      keys: () => {
        this.assertSynchronousCacheAccess()
        return this.listRequireCache()
      }
    }
    return {
      cache,
      request: (specifier) => {
        this.assertSynchronousCacheAccess()
        const url = this.resolvePlanned(specifier, canonicalParent, 'require')
        const module = this.cachedModule(url)
        if (module.format === 'module') throw new RequireEsmError(url)
        return {
          cached: this.evaluationCache.get(url),
          module: this.snapshotModule(module),
          url
        }
      },
      resolve: (specifier) => {
        this.assertSynchronousCacheAccess()
        return this.resolvePlanned(specifier, canonicalParent, 'require')
      }
    }
  }

  beginEvaluation(url: string, initialExports: unknown = {}): ModuleEvaluationCacheEntry {
    this.assertSynchronousCacheAccess()
    const canonicalUrl = this.canonicalizeCachedModuleUrl(url)
    const existing = this.evaluationCache.get(canonicalUrl)
    if (existing != null) return existing
    const module = this.cachedModule(canonicalUrl)
    const entry: ModuleEvaluationCacheEntry = {
      exports: initialExports,
      format: module.format,
      state: 'evaluating',
      url: canonicalUrl
    }
    this.evaluationCache.set(canonicalUrl, entry)
    return entry
  }

  completeEvaluation(url: string, exports: unknown): ModuleEvaluationCacheEntry {
    this.assertSynchronousCacheAccess()
    const canonicalUrl = this.canonicalizeCachedModuleUrl(url)
    const module = this.cachedModule(canonicalUrl)
    const entry: ModuleEvaluationCacheEntry = {
      exports,
      format: module.format,
      state: 'evaluated',
      url: canonicalUrl
    }
    this.evaluationCache.set(canonicalUrl, entry)
    return entry
  }

  failEvaluation(url: string): boolean {
    this.assertSynchronousCacheAccess()
    return this.evaluationCache.delete(this.canonicalizeCachedModuleUrl(url))
  }

  getEvaluation(url: string): ModuleEvaluationCacheEntry | undefined {
    this.assertSynchronousCacheAccess()
    return this.evaluationCache.get(this.canonicalizeCachedModuleUrl(url))
  }

  private normalizeRootUrl(value: string) {
    let root: URL
    try {
      root = new URL(value)
    } catch {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INVALID_URL',
        `Invalid Holonomy module root URL: ${value}`,
        { diagnosticCode: 'INVALID_URL', url: value }
      )
    }
    if (
      root.protocol === '' || root.protocol === 'node:' || root.pathname === '' ||
      !root.href.startsWith(`${root.protocol}//`)
    ) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_UNSUPPORTED_SCHEME',
        `Holonomy module root must use an absolute hierarchical URL, received ${value}`,
        { url: value }
      )
    }
    if (root.search !== '' || root.hash !== '') {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INVALID_URL',
        'Holonomy module root cannot include a query or fragment',
        { url: value }
      )
    }
    if (!root.pathname.endsWith('/')) root.pathname += '/'
    this.assertSafeEncodedPath(root, value)
    return root.toString()
  }

  private canonicalizeModuleParent(value: string) {
    if (this.port.syntheticNodeModules[value] != null || SYNTHETIC_SCHEME.test(value)) {
      return this.resolveSynthetic(value)
    }
    return this.canonicalizeModuleUrl(value, this.rootUrl, false)
  }

  private canonicalizeModuleUrl(value: string, parentUrl: string, allowFragment: boolean) {
    if (value.includes('\\') || value.includes('\0')) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INVALID_URL',
        `Invalid module URL: ${value}`,
        { url: value }
      )
    }
    let url: URL
    try {
      url = new URL(value, parentUrl)
    } catch {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INVALID_URL',
        `Invalid module URL: ${value}`,
        { diagnosticCode: 'INVALID_URL', url: value }
      )
    }
    if (!allowFragment && url.hash !== '') {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INVALID_URL',
        'Module URLs cannot include fragments',
        { url: url.toString() }
      )
    }
    this.assertSafeEncodedPath(url, value)
    const root = new URL(this.rootUrl)
    if (
      url.protocol !== root.protocol ||
      url.username !== root.username ||
      url.password !== root.password ||
      url.host !== root.host ||
      !url.pathname.startsWith(root.pathname)
    ) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_PATH_ESCAPE',
        `Module URL escapes the configured root: ${url.toString()}`,
        { url: url.toString() }
      )
    }
    return url.toString()
  }

  private assertSafeEncodedPath(url: URL, original: string) {
    if (/%(?:00|2f|5c)/iu.test(url.pathname)) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INVALID_URL',
        `Encoded separator or NUL is not allowed in module URLs: ${original}`,
        { url: original }
      )
    }
    try {
      const decoded = decodeURIComponent(url.pathname)
      if (decoded.includes('\\') || decoded.includes('\0')) throw new Error('unsafe path')
    } catch {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INVALID_URL',
        `Invalid encoded module URL path: ${original}`,
        { diagnosticCode: 'INVALID_URL', url: original }
      )
    }
  }

  private resolveSynthetic(specifier: string) {
    if (
      specifier.includes('?') || specifier.includes('#') || specifier === 'node:' || specifier === 'holo:' ||
      this.port.syntheticNodeModules[specifier] == null
    ) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_SYNTHETIC_NOT_FOUND',
        `Synthetic module is not declared by the host: ${specifier}`,
        { specifier }
      )
    }
    return specifier
  }

  private async resolveExistingModuleUrl(url: string, transaction: LoaderTransaction) {
    const base = new URL(url)
    const extension = pathExtension(url)
    if (extension !== '') this.assertSupportedModuleExtension(url)
    const candidates = extension === ''
      ? [
        withPathSuffix(base, '.js'),
        withPathSuffix(base, '.mjs'),
        withPathSuffix(base, '.cjs'),
        ...(this.allowJsonModules ? [withPathSuffix(base, '.json')] : []),
        withPathSuffix(base, '/index.js'),
        withPathSuffix(base, '/index.mjs'),
        withPathSuffix(base, '/index.cjs'),
        ...(this.allowJsonModules ? [withPathSuffix(base, '/index.json')] : [])
      ]
      : [
        url
      ]
    for (const candidate of unique(candidates)) {
      if (await this.readVerifiedSource(candidate, transaction) != null) return candidate
    }
    throw new HolonomyModuleLoaderError(
      'ERR_HOLONOMY_MODULE_NOT_FOUND',
      `Cannot find Holonomy module ${url}`,
      { url }
    )
  }

  private async resolvePackage(
    specifier: string,
    parentUrl: string,
    mode: ModuleResolutionMode,
    transaction: LoaderTransaction
  ) {
    const parsed = splitPackageSpecifier(specifier)
    if (parsed == null) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_NOT_FOUND',
        `Invalid or unsupported bare package specifier: ${specifier}`,
        { specifier }
      )
    }
    let searchDirectory = toDirectoryUrl(new URL(parentUrl))
    const root = new URL(this.rootUrl)
    while (searchDirectory.pathname.startsWith(root.pathname)) {
      const packageRoot = new URL(`node_modules/${parsed.packageName}/`, searchDirectory).toString()
      const packageJsonUrl = new URL('package.json', packageRoot).toString()
      if (await this.readVerifiedSource(packageJsonUrl, transaction) != null) {
        const packageData = await this.readPackage(packageRoot, transaction)
        return this.resolvePackageEntry(packageData, parsed.exportKey, mode, specifier, transaction)
      }
      if (searchDirectory.pathname === root.pathname) break
      const parent = parentDirectoryUrl(searchDirectory)
      if (!parent.pathname.startsWith(root.pathname) || parent.pathname === searchDirectory.pathname) break
      searchDirectory = parent
    }
    throw new HolonomyModuleLoaderError(
      'ERR_HOLONOMY_MODULE_NOT_FOUND',
      `Cannot find package ${parsed.packageName} from ${parentUrl}`,
      { specifier }
    )
  }

  private async readPackage(rootUrl: string, transaction: LoaderTransaction) {
    const cached = this.packageCache.get(rootUrl)
    if (cached != null) return cached
    if (cached === null) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INVALID_PACKAGE_CONFIG',
        `Invalid cached package configuration at ${rootUrl}`,
        { url: rootUrl }
      )
    }
    const packageJsonUrl = new URL('package.json', rootUrl).toString()
    const source = await this.readVerifiedSource(packageJsonUrl, transaction)
    if (source == null) {
      this.publishPackage(transaction, rootUrl, null)
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INVALID_PACKAGE_CONFIG',
        `Missing package.json at ${packageJsonUrl}`,
        { url: packageJsonUrl }
      )
    }
    try {
      const manifest = JSON.parse(source.source) as unknown
      if (!isRecord(manifest)) throw new Error('package.json must contain an object')
      if (manifest.type != null && manifest.type !== 'module' && manifest.type !== 'commonjs') {
        throw new Error('package.json type must be module or commonjs')
      }
      const parsed: ParsedPackage = {
        manifest,
        rootUrl,
        type: manifest.type === 'module' ? 'module' : 'commonjs'
      }
      this.publishPackage(transaction, rootUrl, parsed)
      return parsed
    } catch {
      this.publishPackage(transaction, rootUrl, null)
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INVALID_PACKAGE_CONFIG',
        `Invalid package.json at ${packageJsonUrl}`,
        { diagnosticCode: 'INVALID_PACKAGE_JSON', url: packageJsonUrl }
      )
    }
  }

  private async resolvePackageEntry(
    packageData: ParsedPackage,
    exportKey: string,
    mode: ModuleResolutionMode,
    specifier: string,
    transaction: LoaderTransaction
  ) {
    const { manifest, rootUrl } = packageData
    let target: string | undefined
    if (manifest.exports !== undefined) {
      const selected = selectExportEntry(manifest.exports, exportKey)
      target = selected == null
        ? undefined
        : selectConditionalTarget(
          selected.entry,
          mode === 'import' ? this.importConditions : this.requireConditions,
          selected.pattern
        )
      if (target == null) {
        throw new HolonomyModuleLoaderError(
          'ERR_PACKAGE_PATH_NOT_EXPORTED',
          `Package subpath ${exportKey} is not exported by ${rootUrl}`,
          { specifier, url: rootUrl }
        )
      }
    } else if (exportKey !== '.') {
      target = exportKey
    } else {
      const preferred = mode === 'import'
        ? [manifest.module, manifest.main]
        : [manifest.main, manifest.module]
      target = preferred.find(value => typeof value === 'string') as string | undefined
      target ??= './index.js'
    }
    if (!target.startsWith('./') || target.includes('\0') || target.includes('\\')) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INVALID_PACKAGE_CONFIG',
        `Package export target must be package-relative: ${String(target)}`,
        { specifier, url: rootUrl }
      )
    }
    const resolved = this.canonicalizeModuleUrl(target, rootUrl, false)
    if (!resolved.startsWith(rootUrl)) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_PATH_ESCAPE',
        `Package export escapes package root: ${target}`,
        { specifier, url: resolved }
      )
    }
    return this.resolveExistingModuleUrl(resolved, transaction)
  }

  private async readVerifiedSource(
    url: string,
    transaction: LoaderTransaction
  ): Promise<VerifiedSource | null> {
    const cached = this.sourceCache.get(url)
    if (cached != null) {
      this.accountSource(transaction, url, cached.byteLength)
      return cached
    }
    if (this.negativeSourceCache.has(url)) return null
    const hostSource = await this.readHostSource(url)
    if (hostSource == null) {
      this.publishNegativeSource(transaction, url)
      return null
    }
    if (!(hostSource.bytes instanceof Uint8Array) || typeof hostSource.sha256 !== 'string') {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_SOURCE_INVALID',
        'Host module source must contain canonical bytes and a SHA-256 digest',
        { diagnosticCode: 'INVALID_SOURCE_BYTES', url }
      )
    }
    this.accountSource(transaction, url, hostSource.bytes.byteLength)
    const bytes = new Uint8Array(hostSource.bytes)
    const digest = sha256Hex(bytes)
    const claimedDigest = normalizeDigest(hostSource.sha256)
    const expectedDigest = this.expectedIntegrity.get(url)
    if (claimedDigest == null || digest !== claimedDigest || (expectedDigest != null && digest !== expectedDigest)) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INTEGRITY',
        `SHA-256 integrity verification failed for ${url}`,
        { url }
      )
    }
    let source: string
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_SOURCE_INVALID',
        `Module source is not valid UTF-8: ${url}`,
        { diagnosticCode: 'INVALID_SOURCE_BYTES', url }
      )
    }
    const verified = { byteLength: bytes.byteLength, sha256: digest, source }
    this.publishSource(transaction, url, verified)
    return verified
  }

  private async readHostSource(url: string) {
    let pending: ReturnType<HostModuleLoaderPort['readModule']>
    try {
      this.invokingHostPort = true
      pending = this.port.readModule(url, this.hostReadContext)
    } catch (error) {
      this.throwHostReadError(error, url)
    } finally {
      this.invokingHostPort = false
    }
    try {
      return await pending!
    } catch (error) {
      this.throwHostReadError(error, url)
    }
  }

  private assertSupportedModuleExtension(url: string) {
    const extension = pathExtension(url)
    if (extension === '.node') {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_NATIVE_ADDON_UNSUPPORTED',
        `Native addons are not supported by the Holonomy Runtime: ${url}`,
        { url }
      )
    }
    if (extension === '.json' && !this.allowJsonModules) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_JSON_UNSUPPORTED',
        `JSON modules are disabled: ${url}`,
        { url }
      )
    }
    if (!['.cjs', '.js', '.mjs', ...(this.allowJsonModules ? ['.json'] : [])].includes(extension)) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_FORMAT_UNSUPPORTED',
        `Unsupported Holonomy module format: ${extension === '' ? '<none>' : extension}`,
        { url }
      )
    }
  }

  private async moduleFormat(
    url: string,
    transaction: LoaderTransaction
  ): Promise<PlannedModuleFormat> {
    this.assertSupportedModuleExtension(url)
    const extension = pathExtension(url)
    if (extension === '.mjs') return 'module'
    if (extension === '.cjs') return 'commonjs'
    if (extension === '.json') return 'json'
    return await this.findPackageType(url, transaction) === 'module' ? 'module' : 'commonjs'
  }

  private async findPackageType(
    url: string,
    transaction: LoaderTransaction
  ): Promise<'commonjs' | 'module'> {
    let directory = toDirectoryUrl(new URL(url))
    const root = new URL(this.rootUrl)
    while (directory.pathname.startsWith(root.pathname)) {
      const packageJsonUrl = new URL('package.json', directory).toString()
      if (await this.readVerifiedSource(packageJsonUrl, transaction) != null) {
        return (await this.readPackage(directory.toString(), transaction)).type
      }
      if (directory.pathname === root.pathname) break
      const parent = parentDirectoryUrl(directory)
      if (!parent.pathname.startsWith(root.pathname) || parent.pathname === directory.pathname) break
      directory = parent
    }
    return 'commonjs'
  }

  private async loadModule(
    url: string,
    transaction: LoaderTransaction
  ): Promise<MutablePlannedModule> {
    this.accountModule(transaction, url)
    const cached = this.moduleCache.get(url)
    if (cached != null) return cached
    if (this.port.syntheticNodeModules[url] != null) {
      const synthetic = this.port.syntheticNodeModules[url]
      if (synthetic == null) this.resolveSynthetic(url)
      const module: MutablePlannedModule = {
        dependencies: [],
        exportNames: unique(synthetic?.exportNames ?? []).sort(),
        format: 'synthetic',
        sha256: null,
        source: null,
        url
      }
      this.publishModule(transaction, url, module)
      return module
    }
    const source = await this.readVerifiedSource(url, transaction)
    if (source == null) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_NOT_FOUND',
        `Cannot load Holonomy module ${url}`,
        { url }
      )
    }
    const format = await this.moduleFormat(url, transaction)
    if (format === 'json') {
      try {
        JSON.parse(source.source)
      } catch {
        throw new HolonomyModuleLoaderError(
          'ERR_HOLONOMY_MODULE_SOURCE_INVALID',
          `Invalid JSON module ${url}`,
          { diagnosticCode: 'INVALID_SOURCE_SYNTAX', url }
        )
      }
    }
    const analysis = analyzeModuleSource(source.source, format, url, this.limits)
    if (analysis.dependencies.length > this.limits.maxDependenciesPerModule) {
      throw this.resourceExhausted('module dependencies', url)
    }
    if (analysis.usesDlopen) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_NATIVE_ADDON_UNSUPPORTED',
        `process.dlopen is not supported by the Holonomy Runtime: ${url}`,
        { url }
      )
    }
    const module: MutablePlannedModule = {
      dependencies: [],
      exportNames: analysis.exportNames,
      format,
      sha256: source.sha256,
      source: source.source,
      url
    }
    this.publishModule(transaction, url, module)

    for (const dependency of analysis.dependencies) {
      if (dependency.kind === 'require' && dependency.specifier == null) {
        throw new HolonomyModuleLoaderError(
          'ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED',
          `Dynamic require() is not supported in ${url}`,
          { url }
        )
      }
      if (dependency.kind === 'require-resolve' && dependency.specifier == null) {
        throw new HolonomyModuleLoaderError(
          'ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED',
          `Dynamic require.resolve() is not supported in ${url}`,
          { url }
        )
      }
      if (dependency.specifier == null) {
        module.dependencies.push({
          interop: null,
          kind: dependency.kind,
          resolvedUrl: null,
          specifier: null
        })
        continue
      }
      const mode: ModuleResolutionMode = dependency.kind.startsWith('require') ? 'require' : 'import'
      const resolvedUrl = await this.resolveInternal(dependency.specifier, url, mode, transaction)
      const target = dependency.kind === 'require-resolve'
        ? undefined
        : await this.loadModule(resolvedUrl, transaction)
      if (dependency.kind === 'require' && target?.format === 'module') {
        throw new RequireEsmError(resolvedUrl)
      }
      const targetFormat = target?.format ??
        (this.port.syntheticNodeModules[resolvedUrl] != null
          ? 'synthetic'
          : await this.moduleFormat(resolvedUrl, transaction))
      module.dependencies.push({
        interop: interopForFormat(targetFormat),
        kind: dependency.kind,
        resolvedUrl,
        specifier: dependency.specifier
      })
    }
    return module
  }

  private runTransaction<T>(operation: (transaction: LoaderTransaction) => Promise<T>): Promise<T> {
    const predecessor = this.transactionTail
    let release!: () => void
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve
    })
    return predecessor.then(async () => {
      const transaction: LoaderTransaction = {
        moduleKeys: new Set(),
        moduleUrls: new Set(),
        negativeSourceKeys: new Set(),
        packageKeys: new Set(),
        resolutionKeys: new Set(),
        sourceBytes: new Map(),
        sourceKeys: new Set(),
        totalSourceBytes: 0
      }
      this.activeTransaction = transaction
      try {
        return await operation(transaction)
      } catch (error) {
        this.rollbackTransaction(transaction)
        throw error
      } finally {
        this.activeTransaction = undefined
        release()
      }
    })
  }

  private rollbackTransaction(transaction: LoaderTransaction) {
    for (const key of transaction.resolutionKeys) this.resolutionCache.delete(key)
    for (const key of transaction.moduleKeys) this.moduleCache.delete(key)
    for (const key of transaction.packageKeys) this.packageCache.delete(key)
    for (const key of transaction.sourceKeys) this.sourceCache.delete(key)
    for (const key of transaction.negativeSourceKeys) this.negativeSourceCache.delete(key)
  }

  private publishResolution(transaction: LoaderTransaction, key: string, url: string) {
    const existing = this.resolutionCache.get(key)
    if (existing != null) return existing
    this.resolutionCache.set(key, url)
    transaction.resolutionKeys.add(key)
    return url
  }

  private publishModule(
    transaction: LoaderTransaction,
    key: string,
    module: MutablePlannedModule
  ) {
    if (this.moduleCache.has(key)) return
    this.moduleCache.set(key, module)
    transaction.moduleKeys.add(key)
  }

  private publishPackage(
    transaction: LoaderTransaction,
    key: string,
    packageData: ParsedPackage | null
  ) {
    if (this.packageCache.has(key)) return
    this.packageCache.set(key, packageData)
    transaction.packageKeys.add(key)
  }

  private publishSource(transaction: LoaderTransaction, key: string, source: VerifiedSource) {
    if (this.sourceCache.has(key)) return
    this.sourceCache.set(key, source)
    transaction.sourceKeys.add(key)
  }

  private publishNegativeSource(transaction: LoaderTransaction, key: string) {
    if (this.negativeSourceCache.has(key)) return
    this.negativeSourceCache.add(key)
    transaction.negativeSourceKeys.add(key)
  }

  private accountSource(transaction: LoaderTransaction, url: string, byteLength: number) {
    if (byteLength > this.limits.maxSourceBytes) {
      throw this.resourceExhausted('source bytes', url)
    }
    if (transaction.sourceBytes.has(url)) return
    transaction.sourceBytes.set(url, byteLength)
    transaction.totalSourceBytes += byteLength
    if (transaction.totalSourceBytes > this.limits.maxTotalSourceBytesPerPlan) {
      throw this.resourceExhausted('total source bytes', url)
    }
  }

  private accountModule(transaction: LoaderTransaction, url: string) {
    if (transaction.moduleUrls.has(url)) return
    transaction.moduleUrls.add(url)
    if (transaction.moduleUrls.size > this.limits.maxModules) {
      throw this.resourceExhausted('module count', url)
    }
  }

  private resourceExhausted(resource: string, url?: string) {
    return new HolonomyModuleLoaderError(
      'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED',
      `Holonomy module resource limit exceeded: ${resource}`,
      { url }
    )
  }

  private createReentrantHostError() {
    const error = new HolonomyModuleLoaderError(
      'ERR_HOLONOMY_MODULE_REENTRANT_HOST_CALL',
      'HostModuleLoaderPort cannot reenter public module-loader APIs while reading a module'
    )
    this.reentrantHostErrors.add(error)
    return error
  }

  private rejectReentrantHostCall(): Promise<never> {
    return Promise.reject(this.createReentrantHostError())
  }

  private assertPublicAdmissionAllowed() {
    if (!this.invokingHostPort) return
    throw this.createReentrantHostError()
  }

  private throwHostReadError(error: unknown, url: string): never {
    if (error != null && typeof error === 'object' && this.reentrantHostErrors.has(error)) {
      throw error
    }
    throw new HolonomyModuleLoaderError(
      'ERR_HOLONOMY_MODULE_HOST_READ_FAILED',
      'The Holonomy module host could not read a requested module',
      { diagnosticCode: 'HOST_READ_FAILED', url }
    )
  }

  private assertSynchronousCacheAccess() {
    this.assertPublicAdmissionAllowed()
    if (this.activeTransaction == null) return
    throw new HolonomyModuleLoaderError(
      'ERR_HOLONOMY_MODULE_TRANSACTION_ACTIVE',
      'Synchronous module cache access is unavailable while a plan transaction is active'
    )
  }

  private collectReachableModules(entryUrl: string) {
    const reachable = new Set<string>()
    const pending = [entryUrl]
    while (pending.length > 0) {
      const url = pending.pop()!
      if (reachable.has(url)) continue
      const module = this.moduleCache.get(url)
      if (module == null) continue
      reachable.add(url)
      for (const dependency of module.dependencies) {
        if (dependency.kind !== 'require-resolve' && dependency.resolvedUrl != null) {
          pending.push(dependency.resolvedUrl)
        }
      }
    }
    return reachable
  }

  private snapshotModule(module: MutablePlannedModule | undefined): PlannedModule {
    if (module == null) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_NOT_FOUND',
        'Module is not present in the loader cache'
      )
    }
    return {
      dependencies: module.dependencies.map(dependency => ({ ...dependency })),
      exportNames: [...module.exportNames],
      format: module.format,
      sha256: module.sha256,
      source: module.source,
      url: module.url
    }
  }

  private canonicalizeCachedModuleUrl(url: string) {
    return this.port.syntheticNodeModules[url] != null || SYNTHETIC_SCHEME.test(url)
      ? this.resolveSynthetic(url)
      : this.canonicalizeModuleUrl(url, this.rootUrl, false)
  }

  private resolutionKey(parentUrl: string, mode: ModuleResolutionMode, specifier: string) {
    return `${mode}\0${parentUrl}\0${specifier}`
  }

  private resolvePlanned(specifier: string, parentUrl: string, mode: ModuleResolutionMode) {
    const resolved = this.resolutionCache.get(this.resolutionKey(parentUrl, mode, specifier))
    if (resolved != null) return resolved
    throw new HolonomyModuleLoaderError(
      'ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED',
      'CommonJS require requests must be admitted while building the module plan',
      { specifier, url: parentUrl }
    )
  }

  private cachedModule(url: string) {
    const module = this.moduleCache.get(url)
    if (module != null) return module
    throw new HolonomyModuleLoaderError(
      'ERR_HOLONOMY_MODULE_NOT_FOUND',
      'Module is not present in the completed module plan',
      { url }
    )
  }

  private listRequireCache() {
    return [...this.evaluationCache.values()]
      .filter(entry => entry.format === 'commonjs')
      .map(entry => entry.url)
      .sort()
  }

  private getRequireCacheEntry(url: string) {
    const entry = this.evaluationCache.get(this.canonicalizeCachedModuleUrl(url))
    return entry?.format === 'commonjs' ? entry : undefined
  }

  private deleteRequireCache(url: string) {
    const canonicalUrl = this.canonicalizeCachedModuleUrl(url)
    const entry = this.evaluationCache.get(canonicalUrl)
    return entry?.format === 'commonjs' ? this.evaluationCache.delete(canonicalUrl) : false
  }
}
