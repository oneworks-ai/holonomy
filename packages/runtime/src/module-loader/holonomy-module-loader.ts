/* eslint-disable max-lines -- the loader keeps resolution and its caches under one state owner. */
import { encodeBase64 } from '../node-compat/encoding.js'
import { HolonomyModuleLoaderError, RequireEsmError } from './errors.js'
import { sha256Hex } from './sha256.js'
import { analyzeModuleSource } from './source-analysis.js'
import { DEFAULT_HOLONOMY_MODULE_LOADER_LIMITS } from './types.js'
import type {
  CreateModulePlanOptions,
  CreateModuleSourceClosureOptions,
  HolonomyModuleLoaderLimits,
  HolonomyModuleLoaderOptions,
  HostModuleLoaderPort,
  HostModuleReadContext,
  HostModuleSource,
  ModuleDependency,
  ModuleDependencyInterop,
  ModuleEvaluationCacheEntry,
  ModulePlan,
  ModuleReadPurpose,
  ModuleRequireCache,
  ModuleResolutionMode,
  ModuleSourceClosure,
  ModuleSourceClosureExternalReference,
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
const MAX_PACKAGE_TARGET_STEPS = 65_536
const MAX_PACKAGE_TARGET_DEPTH = 32
const MAX_SOURCE_ALIASES = 512
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
  /** Exact retained copy for a later purpose or alias regrant. */
  bytes: Uint8Array
  canonicalUrl: string
  grant: ModuleReadPurpose
  metadataOnly: boolean
  sha256: string
  source: string
}

interface PackageManifest {
  exports?: unknown
  imports?: unknown
  main?: unknown
  module?: unknown
  name?: unknown
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

interface OpaqueExternalModule {
  readonly kind: 'opaque-external'
  readonly url: string
}

const isOpaqueExternalModule = (
  module: MutablePlannedModule | OpaqueExternalModule
): module is OpaqueExternalModule => Object.hasOwn(module, 'kind')

interface LoaderTransaction {
  readonly aliasKeys: Set<string>
  readonly externalReferences: ModuleSourceClosureExternalReference[]
  readonly moduleGrantKeys: Set<string>
  readonly moduleKeys: Set<string>
  readonly moduleUrls: Set<string>
  readonly negativeSourceKeys: Set<string>
  readonly packageKeys: Set<string>
  readonly resolutionKeys: Set<string>
  readonly sourceBytes: Map<string, number>
  readonly sourceKeys: Set<string>
  readonly sourcePriorValues: Map<string, VerifiedSource>
  packageTargetSteps: number
  totalSourceBytes: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value != null && typeof value === 'object' && !Array.isArray(value)
)

const normalizeDigest = (value: string) => {
  return HEX_SHA256.test(value) ? value : undefined
}

const unique = <T>(values: readonly T[]) => [...new Set(values)]

const equalBytes = (left: Uint8Array, right: Uint8Array) =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])

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
  candidate.pathname += candidate.pathname.endsWith('/') && suffix.startsWith('/') ? suffix.slice(1) : suffix
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
  const leftPrefix = leftWildcard < 0 ? left.length : leftWildcard + 1
  const rightPrefix = rightWildcard < 0 ? right.length : rightWildcard + 1
  if (leftPrefix !== rightPrefix) return rightPrefix - leftPrefix
  return right.length - left.length
}

const matchExportPattern = (pattern: string, key: string) => {
  const wildcard = pattern.indexOf('*')
  if (wildcard < 0) return undefined
  const prefix = pattern.slice(0, wildcard)
  const suffix = pattern.slice(wildcard + 1)
  if (key.length < pattern.length || !key.startsWith(prefix) || !key.endsWith(suffix)) return undefined
  return key.slice(prefix.length, key.length - suffix.length)
}

const invalidPackageSegments = (value: string) => {
  for (const segment of value.split('/')) {
    if (segment === '') return true
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return true
    }
    if (
      decoded === '.' || decoded === '..' || decoded.toLowerCase() === 'node_modules' ||
      decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0') ||
      decoded.includes('%') || decoded.includes('?') || decoded.includes('#')
    ) return true
  }
  return false
}

const splitPackageSpecifier = (specifier: string) => {
  if (
    specifier === '' || specifier.includes('\\') || specifier.includes('\0') ||
    specifier.includes('%') || specifier.includes('?') || specifier.includes('#') ||
    specifier.startsWith('#')
  ) {
    return undefined
  }
  const segments = specifier.split('/')
  const packageSegmentCount = specifier.startsWith('@') ? 2 : 1
  if (
    segments.length < packageSegmentCount ||
    segments.some(segment => segment === '' || segment === '.' || segment === '..')
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

const selectImportEntry = (imports: Record<string, unknown>, specifier: string) => {
  if (Object.hasOwn(imports, specifier) && !specifier.includes('*')) {
    return { entry: imports[specifier], pattern: undefined }
  }
  const match = Object.keys(imports)
    .filter(key => key.startsWith('#') && key.includes('*') && key.indexOf('*') === key.lastIndexOf('*'))
    .map(key => ({ key, pattern: matchExportPattern(key, specifier) }))
    .filter((value): value is { key: string; pattern: string } => value.pattern != null)
    .sort((left, right) => compareExportPattern(left.key, right.key))[0]
  return match == null
    ? undefined
    : { entry: imports[match.key], pattern: match.pattern }
}

const selectConditionalTarget = (
  value: unknown,
  conditions: readonly string[],
  pattern: string | undefined,
  transaction: LoaderTransaction,
  validate: (target: string) => string,
  depth = 0
): string | null | undefined => {
  transaction.packageTargetSteps++
  if (transaction.packageTargetSteps > MAX_PACKAGE_TARGET_STEPS || depth > MAX_PACKAGE_TARGET_DEPTH) {
    throw new HolonomyModuleLoaderError(
      'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED',
      'Package target traversal exceeds the Holonomy module limit'
    )
  }
  if (value === null) return null
  if (typeof value === 'string') {
    return validate(pattern == null ? value : value.replaceAll('*', pattern))
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    let lastOutcome: HolonomyModuleLoaderError | null | undefined
    for (const item of value) {
      try {
        const selected = selectConditionalTarget(item, conditions, pattern, transaction, validate, depth + 1)
        if (selected === undefined) continue
        if (selected === null) {
          lastOutcome = null
          continue
        }
        return selected
      } catch (error) {
        if (!(error instanceof HolonomyModuleLoaderError) || error.code !== 'ERR_INVALID_PACKAGE_TARGET') {
          throw error
        }
        lastOutcome = error
      }
    }
    if (lastOutcome instanceof HolonomyModuleLoaderError) throw lastOutcome
    return lastOutcome
  }
  if (!isRecord(value)) {
    throw new HolonomyModuleLoaderError('ERR_INVALID_PACKAGE_TARGET', 'Invalid package target type')
  }
  const keys = Object.keys(value)
  if (keys.some(key => /^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < 0xFFFF_FFFF)) {
    throw new HolonomyModuleLoaderError(
      'ERR_HOLONOMY_MODULE_INVALID_PACKAGE_CONFIG',
      'Package conditions cannot contain numeric keys'
    )
  }
  for (const condition of keys) {
    if (condition !== 'default' && !conditions.includes(condition)) continue
    const selected = selectConditionalTarget(value[condition], conditions, pattern, transaction, validate, depth + 1)
    if (selected !== undefined) return selected
  }
  return undefined
}

export class HolonomyModuleLoader {
  readonly limits: Readonly<HolonomyModuleLoaderLimits>
  readonly rootUrl: string

  private readonly allowJsonModules: boolean
  private readonly aliasCache = new Map<string, string>()
  private closureHostReads = 0
  private readonly captureDynamicImports: boolean
  private closureExternalClassifier?: (specifier: string) => boolean
  private readonly closureExternalUrls = new Set<string>()
  private readonly evaluationCache = new Map<string, ModuleEvaluationCacheEntry>()
  private readonly expectedIntegrity = new Map<string, string>()
  private readonly hostReadContexts: Readonly<Record<ModuleReadPurpose, HostModuleReadContext>>
  private readonly importConditions: readonly string[]
  private readonly moduleCache = new Map<string, MutablePlannedModule | OpaqueExternalModule>()
  private readonly moduleGrantUrls = new Set<string>()
  private readonly negativeSourceCache = new Set<string>()
  private readonly packageCache = new Map<string, ParsedPackage | null>()
  private readonly port: HostModuleLoaderPort
  private readonly requireConditions: readonly string[]
  private readonly resolutionProfile: 'production' | 'source'
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
    this.captureDynamicImports = options.captureDynamicImports === true
    this.limits = snapshotLimits(options.limits)
    const rejectHostReentry = () => this.rejectReentrantHostCall()
    const loader = Object.freeze({
      createPlan: rejectHostReentry,
      createSourceClosure: rejectHostReentry,
      load: rejectHostReentry,
      resolve: rejectHostReentry
    })
    this.hostReadContexts = Object.freeze({
      module: Object.freeze({ loader, purpose: 'module' }),
      packageMetadata: Object.freeze({ loader, purpose: 'packageMetadata' })
    })
    const sourceProfile = options.resolutionProfile === 'source'
    this.resolutionProfile = sourceProfile ? 'source' : 'production'
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

  /**
   * Reads a bounded, non-executable source closure in a private loader. Its
   * opaque external names never enter this loader's executable plan cache.
   */
  async createSourceClosure(
    entrySpecifier: string,
    options: CreateModuleSourceClosureOptions
  ): Promise<ModuleSourceClosure> {
    this.assertPublicAdmissionAllowed()
    const relayHostReentry = (error: unknown): never => {
      if (error != null && typeof error === 'object' && this.reentrantHostErrors.has(error)) {
        loader.reentrantHostErrors.add(error)
      }
      throw error
    }
    const loader = new HolonomyModuleLoader({
      readModule: (url, context) => {
        this.closureHostReads++
        try {
          const pending = this.port.readModule(url, context)
          return Promise.resolve(pending).catch(relayHostReentry).finally(() => {
            this.closureHostReads--
          })
        } catch (error) {
          this.closureHostReads--
          return relayHostReentry(error)
        }
      },
      syntheticNodeModules: Object.freeze(Object.create(null)) as HostModuleLoaderPort['syntheticNodeModules']
    }, {
      allowJsonModules: this.allowJsonModules,
      captureDynamicImports: true,
      integrity: Object.fromEntries(this.expectedIntegrity),
      limits: this.limits,
      resolutionProfile: this.resolutionProfile,
      rootUrl: this.rootUrl
    })
    loader.closureExternalClassifier = options.isExternalModule
    return loader.buildSourceClosure(entrySpecifier, options)
  }

  private async buildSourceClosure(
    entrySpecifier: string,
    options: CreateModulePlanOptions
  ): Promise<ModuleSourceClosure> {
    return this.runTransaction(async (transaction) => {
      const parentUrl = options.parentUrl ?? new URL('__entry__.mjs', this.rootUrl).toString()
      const entryUrl = await this.resolveInternal(
        entrySpecifier,
        parentUrl,
        options.mode ?? 'import',
        transaction
      )
      if (this.closureExternalUrls.has(entryUrl)) {
        transaction.externalReferences.push({
          kind: 'entry',
          parentUrl,
          specifier: entrySpecifier,
          url: entryUrl
        })
      }
      const entry = await this.loadModule(entryUrl, transaction)
      const reads = [...transaction.sourceBytes.keys()].sort().map((url) => {
        const source = this.sourceCache.get(url)!
        return Object.freeze({
          byteLength: source.byteLength,
          bytesBase64: encodeBase64(source.bytes, false),
          ...(source.metadataOnly ? { metadataOnly: true as const } : {}),
          sha256: source.sha256,
          url
        })
      })
      const aliases = [...transaction.aliasKeys].sort().map(url =>
        Object.freeze({
          canonicalUrl: this.aliasCache.get(url)!,
          url
        })
      )
      const externalReferences = transaction.externalReferences.map(reference => Object.freeze(reference))
      return Object.freeze({
        aliases: Object.freeze(aliases),
        entryUrl: entry.url,
        externalReferences: Object.freeze(externalReferences),
        kind: 'source-closure' as const,
        reads: Object.freeze(reads),
        rootUrl: this.rootUrl
      })
    })
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
    if (cached != null) return this.canonicalizeResolvedModuleAlias(cached, transaction)
    const externalUrl = this.resolveClosureExternal(specifier)
    if (externalUrl != null) {
      this.closureExternalUrls.add(externalUrl)
      return this.publishResolution(transaction, resolutionKey, externalUrl)
    }
    let resolvedUrl: string
    const declaredBuiltin =
      !specifier.startsWith('#') && Object.hasOwn(this.port.syntheticNodeModules, `node:${specifier}`)
        ? `node:${specifier}`
        : specifier
    if (Object.hasOwn(this.port.syntheticNodeModules, declaredBuiltin) || SYNTHETIC_SCHEME.test(declaredBuiltin)) {
      resolvedUrl = this.resolveSynthetic(declaredBuiltin)
      return this.publishResolution(transaction, resolutionKey, resolvedUrl)
    }
    if (specifier.startsWith('#')) {
      resolvedUrl = await this.resolvePackageImport(specifier, canonicalParent, mode, transaction)
    } else if (specifier.startsWith('.') || specifier.startsWith('/') || SCHEME.test(specifier)) {
      const url = this.canonicalizeModuleUrl(specifier, canonicalParent, false)
      resolvedUrl = await this.resolveExistingModuleUrl(url, transaction, mode === 'import')
    } else {
      resolvedUrl = await this.resolvePackage(specifier, canonicalParent, mode, transaction)
    }
    return this.publishResolution(
      transaction,
      resolutionKey,
      await this.canonicalizeResolvedModuleAlias(resolvedUrl, transaction)
    )
  }

  private resolveClosureExternal(specifier: string): string | undefined {
    const classify = this.closureExternalClassifier
    if (classify == null) return undefined
    const reserved = specifier.startsWith('node:') || specifier.startsWith('holo:')
    const bare = !reserved && !specifier.startsWith('#') && !specifier.startsWith('.') &&
      !specifier.startsWith('/') && !SCHEME.test(specifier)
    if ((!reserved && !bare) || !classify(specifier)) return undefined
    if (
      specifier === 'node:' || specifier === 'holo:' || specifier.includes('?') ||
      specifier.includes('#') || specifier.includes('\\') || specifier.includes('\0') ||
      (bare && splitPackageSpecifier(specifier) == null)
    ) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_SYNTHETIC_NOT_FOUND',
        `Invalid opaque external module reference: ${specifier}`,
        { specifier }
      )
    }
    return bare ? `node:${specifier}` : specifier
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
      const entry = await this.loadModule(entryUrl, transaction)
      const reachable = this.collectReachableModules(entry.url)
      return {
        entryUrl: entry.url,
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
      const url = Object.hasOwn(this.port.syntheticNodeModules, canonicalUrl) || SYNTHETIC_SCHEME.test(canonicalUrl)
        ? this.resolveSynthetic(canonicalUrl)
        : this.canonicalizeModuleUrl(canonicalUrl, this.rootUrl, false)
      return this.snapshotModule(await this.loadModule(url, transaction))
    })
  }

  createRequire(parentUrl: string): PlannedRequire {
    this.assertSynchronousCacheAccess()
    const requestedParent = Object.hasOwn(this.port.syntheticNodeModules, parentUrl) || SYNTHETIC_SCHEME.test(parentUrl)
      ? this.resolveSynthetic(parentUrl)
      : this.canonicalizeModuleUrl(parentUrl, this.rootUrl, false)
    const canonicalParent = this.knownCanonicalUrl(requestedParent)
    this.assertCachedModuleGrant(requestedParent, canonicalParent)
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
    if (Object.hasOwn(this.port.syntheticNodeModules, value) || SYNTHETIC_SCHEME.test(value)) {
      return this.resolveSynthetic(value)
    }
    return this.knownCanonicalUrl(this.canonicalizeModuleUrl(value, this.rootUrl, false))
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
      !Object.hasOwn(this.port.syntheticNodeModules, specifier)
    ) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_SYNTHETIC_NOT_FOUND',
        `Synthetic module is not declared by the host: ${specifier}`,
        { specifier }
      )
    }
    return specifier
  }

  private async resolveExistingModuleUrl(
    url: string,
    transaction: LoaderTransaction,
    exact = false
  ) {
    const base = new URL(url)
    const extension = pathExtension(url)
    if (extension !== '') this.assertSupportedModuleExtension(url)
    const candidates = exact ? [url] : extension === ''
      ? [
        ...(base.pathname.endsWith('/') ? [] : [
          url,
          withPathSuffix(base, '.js'),
          withPathSuffix(base, '.mjs'),
          withPathSuffix(base, '.cjs'),
          ...(this.allowJsonModules ? [withPathSuffix(base, '.json')] : [])
        ]),
        withPathSuffix(base, '/index.js'),
        withPathSuffix(base, '/index.mjs'),
        withPathSuffix(base, '/index.cjs'),
        ...(this.allowJsonModules ? [withPathSuffix(base, '/index.json')] : [])
      ]
      : [
        url
      ]
    for (const candidate of unique(candidates)) {
      const source = await this.readVerifiedSource(candidate, transaction)
      if (source != null) {
        this.assertSupportedModuleExtension(source.canonicalUrl)
        return source.canonicalUrl
      }
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
    const scope = await this.findPackageScope(parentUrl, transaction)
    if (scope?.manifest.name === parsed.packageName && scope.manifest.exports !== undefined) {
      return this.resolvePackageEntry(scope, parsed.exportKey, mode, specifier, transaction)
    }
    let searchDirectory = toDirectoryUrl(new URL(parentUrl))
    const root = new URL(this.rootUrl)
    while (searchDirectory.pathname.startsWith(root.pathname)) {
      const packageRoot = new URL(`node_modules/${parsed.packageName}/`, searchDirectory).toString()
      const packageJsonUrl = new URL('package.json', packageRoot).toString()
      if (await this.readVerifiedSource(packageJsonUrl, transaction, 'packageMetadata') != null) {
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

  private async findPackageScope(parentUrl: string, transaction: LoaderTransaction) {
    if (SYNTHETIC_SCHEME.test(parentUrl)) return undefined
    let directory = toDirectoryUrl(new URL(parentUrl))
    const root = new URL(this.rootUrl)
    while (directory.pathname.startsWith(root.pathname)) {
      if (directory.pathname.endsWith('/node_modules/')) break
      const packageJsonUrl = new URL('package.json', directory).toString()
      if (await this.readVerifiedSource(packageJsonUrl, transaction, 'packageMetadata') != null) {
        return this.readPackage(directory.toString(), transaction)
      }
      if (directory.pathname === root.pathname) break
      const parent = parentDirectoryUrl(directory)
      if (!parent.pathname.startsWith(root.pathname) || parent.pathname === directory.pathname) break
      directory = parent
    }
    return undefined
  }

  private invalidPackageTarget(target: string, specifier: string, rootUrl: string) {
    return new HolonomyModuleLoaderError(
      'ERR_INVALID_PACKAGE_TARGET',
      `Invalid package target ${JSON.stringify(target)} from ${rootUrl}`,
      { specifier, url: rootUrl }
    )
  }

  private validatePackageTarget(target: string, specifier: string, rootUrl: string, internal: boolean) {
    if (target.startsWith('./')) {
      const path = target.slice(2).split(/[?#]/u, 1)[0]
      if (/%(?:2f|5c)/iu.test(path)) {
        throw new HolonomyModuleLoaderError(
          'ERR_INVALID_MODULE_SPECIFIER',
          `Encoded separator in package target ${JSON.stringify(target)}`,
          { specifier, url: rootUrl }
        )
      }
      if (path === '' || target.includes('#') || invalidPackageSegments(path)) {
        throw this.invalidPackageTarget(target, specifier, rootUrl)
      }
      let resolved: string
      try {
        resolved = this.canonicalizeModuleUrl(target, rootUrl, false)
      } catch {
        throw this.invalidPackageTarget(target, specifier, rootUrl)
      }
      if (!resolved.startsWith(rootUrl)) throw this.invalidPackageTarget(target, specifier, rootUrl)
      return target
    }
    if (internal && target.startsWith('#') && target !== '#' && !target.startsWith('#/')) return target
    if (internal && splitPackageSpecifier(target) != null && !SCHEME.test(target)) return target
    throw this.invalidPackageTarget(target, specifier, rootUrl)
  }

  private async resolvePackageImport(
    specifier: string,
    parentUrl: string,
    mode: ModuleResolutionMode,
    transaction: LoaderTransaction
  ) {
    if (
      specifier === '#' || specifier.startsWith('#/') || specifier.endsWith('/') ||
      specifier.includes('\\') || specifier.includes('%') ||
      invalidPackageSegments(specifier.slice(1))
    ) {
      throw new HolonomyModuleLoaderError(
        'ERR_INVALID_MODULE_SPECIFIER',
        `Invalid internal package import specifier: ${specifier}`,
        { specifier, url: parentUrl }
      )
    }
    const scope = await this.findPackageScope(parentUrl, transaction)
    const imports = scope?.manifest.imports
    if (imports != null && !isRecord(imports)) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INVALID_PACKAGE_CONFIG',
        `Package imports must be an object at ${scope?.rootUrl}`,
        { specifier, url: scope?.rootUrl }
      )
    }
    const selected = imports == null ? undefined : selectImportEntry(imports, specifier)
    const target = selected == null || scope == null
      ? undefined
      : selectConditionalTarget(
        selected.entry,
        mode === 'import' ? this.importConditions : this.requireConditions,
        selected.pattern,
        transaction,
        value => this.validatePackageTarget(value, specifier, scope.rootUrl, true)
      )
    if (target == null) {
      throw new HolonomyModuleLoaderError(
        'ERR_PACKAGE_IMPORT_NOT_DEFINED',
        `Package import ${specifier} is not defined from ${parentUrl}`,
        { specifier, url: scope?.rootUrl ?? parentUrl }
      )
    }
    if (target.startsWith('./')) {
      const resolved = this.canonicalizeModuleUrl(target, scope!.rootUrl, false)
      this.assertSupportedModuleExtension(resolved)
      const canonical = await this.canonicalizeResolvedModuleAlias(resolved, transaction)
      this.assertSupportedModuleExtension(canonical)
      return canonical
    }
    if (target.startsWith('#')) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_NOT_FOUND',
        `Package target is not an external package: ${target}`,
        { specifier: target, url: scope!.rootUrl }
      )
    }
    return this.resolveInternal(target, new URL('package.json', scope!.rootUrl).toString(), mode, transaction)
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
    const source = await this.readVerifiedSource(packageJsonUrl, transaction, 'packageMetadata')
    if (source == null) {
      this.publishPackage(transaction, rootUrl, null)
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INVALID_PACKAGE_CONFIG',
        `Missing package.json at ${packageJsonUrl}`,
        { url: packageJsonUrl }
      )
    }
    try {
      if (!new URL(source.canonicalUrl).pathname.endsWith('/package.json')) {
        throw new Error('canonical package source must end in package.json')
      }
      const manifest = JSON.parse(source.source) as unknown
      if (!isRecord(manifest)) throw new Error('package.json must contain an object')
      if (manifest.type != null && manifest.type !== 'module' && manifest.type !== 'commonjs') {
        throw new Error('package.json type must be module or commonjs')
      }
      const canonicalRootUrl = new URL('./', source.canonicalUrl).toString()
      const parsed: ParsedPackage = {
        manifest,
        rootUrl: canonicalRootUrl,
        type: manifest.type === 'module' ? 'module' : 'commonjs'
      }
      this.publishPackage(transaction, rootUrl, parsed)
      this.publishPackage(transaction, canonicalRootUrl, parsed)
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
    const hasExports = manifest.exports !== undefined
    let target: string | null | undefined
    if (hasExports) {
      const selected = selectExportEntry(manifest.exports, exportKey)
      target = selected == null
        ? undefined
        : selectConditionalTarget(
          selected.entry,
          mode === 'import' ? this.importConditions : this.requireConditions,
          selected.pattern,
          transaction,
          value => this.validatePackageTarget(value, specifier, rootUrl, false)
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
      target = preferred.find(value => typeof value === 'string' && value !== '') as string | undefined
      target ??= './index.js'
    }
    if (
      !hasExports && target !== '' && !target.startsWith('./') &&
      !target.startsWith('../') && !target.startsWith('/') && !target.startsWith('#') &&
      !SCHEME.test(target)
    ) {
      target = `./${target}`
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
    if (hasExports) {
      this.assertSupportedModuleExtension(resolved)
      const canonical = await this.canonicalizeResolvedModuleAlias(resolved, transaction)
      this.assertSupportedModuleExtension(canonical)
      return canonical
    }
    return this.resolveExistingModuleUrl(resolved, transaction)
  }

  private async canonicalizeResolvedModuleAlias(url: string, transaction: LoaderTransaction): Promise<string> {
    if (this.aliasCache.has(url)) {
      const canonicalUrl = this.knownCanonicalUrl(url)
      const source = this.sourceCache.get(canonicalUrl)
      if (!this.moduleGrantUrls.has(url) || source?.metadataOnly === true) {
        const granted = await this.readVerifiedSource(url, transaction)
        if (granted == null) {
          throw new HolonomyModuleLoaderError(
            'ERR_HOLONOMY_MODULE_HOST_READ_FAILED',
            'The Holonomy module host did not grant source access',
            { diagnosticCode: 'HOST_READ_FAILED', url }
          )
        }
      }
    }
    return this.knownCanonicalUrl(url)
  }

  private async readVerifiedSource(
    url: string,
    transaction: LoaderTransaction,
    purpose: ModuleReadPurpose = 'module'
  ): Promise<VerifiedSource | null> {
    const cached = this.sourceCache.get(this.knownCanonicalUrl(url))
    if (
      cached != null && (purpose === 'packageMetadata' ||
        this.moduleGrantUrls.has(url) && !cached.metadataOnly)
    ) {
      this.accountSource(transaction, cached.canonicalUrl, cached.byteLength)
      return cached
    }
    const negativeKey = `${purpose}\0${url}`
    if (cached == null && this.negativeSourceCache.has(negativeKey)) return null
    const hostSource = await this.readHostSource(url, purpose)
    if (hostSource == null) {
      if (cached != null) {
        throw new HolonomyModuleLoaderError(
          'ERR_HOLONOMY_MODULE_HOST_READ_FAILED',
          'The Holonomy module host did not grant source access',
          { diagnosticCode: 'HOST_READ_FAILED', url }
        )
      }
      this.publishNegativeSource(transaction, negativeKey)
      return null
    }
    if (!(hostSource.bytes instanceof Uint8Array) || typeof hostSource.sha256 !== 'string') {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_SOURCE_INVALID',
        'Host module source must contain canonical bytes and a SHA-256 digest',
        { diagnosticCode: 'INVALID_SOURCE_BYTES', url }
      )
    }
    const metadataOnly = this.readHostMetadataOnly(hostSource, purpose, url)
    const canonicalUrl = this.canonicalizeHostSourceUrl(hostSource.canonicalUrl, url)
    if (cached != null && canonicalUrl !== cached.canonicalUrl) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_SOURCE_INVALID',
        `Host module canonical identity changed for ${url}`,
        { diagnosticCode: 'INVALID_URL', url }
      )
    }
    if (canonicalUrl !== url && this.aliasCache.has(canonicalUrl)) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_SOURCE_INVALID',
        `Host module canonical URL must not be another alias: ${url}`,
        { url }
      )
    }
    this.accountSource(transaction, canonicalUrl, hostSource.bytes.byteLength)
    const bytes = new Uint8Array(hostSource.bytes)
    const digest = sha256Hex(bytes)
    const claimedDigest = normalizeDigest(hostSource.sha256)
    const expectedDigest = this.expectedIntegrity.get(url)
    const expectedCanonicalDigest = this.expectedIntegrity.get(canonicalUrl)
    const existing = this.sourceCache.get(canonicalUrl)
    if (
      claimedDigest == null || digest !== claimedDigest ||
      (expectedDigest != null && digest !== expectedDigest) ||
      (expectedCanonicalDigest != null && digest !== expectedCanonicalDigest) ||
      (existing != null && (digest !== existing.sha256 || !equalBytes(bytes, existing.bytes)))
    ) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_INTEGRITY',
        `SHA-256 integrity verification failed for ${url}`,
        { url }
      )
    }
    if (existing != null) {
      let verified = existing
      if (purpose === 'module') {
        verified = { ...existing, grant: 'module', metadataOnly: false }
      } else if (metadataOnly && !existing.metadataOnly) {
        verified = { ...existing, metadataOnly: true }
      }
      if (verified !== existing) this.replaceSource(transaction, canonicalUrl, verified)
      if (purpose === 'module') this.publishModuleGrant(transaction, url, canonicalUrl)
      this.publishAlias(transaction, url, canonicalUrl)
      return verified
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
    const verified = {
      byteLength: bytes.byteLength,
      bytes,
      canonicalUrl,
      grant: purpose,
      metadataOnly,
      sha256: digest,
      source
    }
    this.publishSource(transaction, canonicalUrl, verified)
    if (purpose === 'module') this.publishModuleGrant(transaction, url, canonicalUrl)
    this.publishAlias(transaction, url, canonicalUrl)
    return verified
  }

  private readHostMetadataOnly(
    source: HostModuleSource,
    purpose: ModuleReadPurpose,
    url: string
  ): boolean {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, 'metadataOnly')
      if (descriptor == null && 'metadataOnly' in source) throw new Error('inherited restriction')
    } catch {
      throw this.invalidHostMetadataOnly(url)
    }
    if (descriptor == null) return false
    if (!Object.hasOwn(descriptor, 'value') || descriptor.value !== true) {
      throw this.invalidHostMetadataOnly(url)
    }
    if (purpose === 'module') {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_HOST_READ_FAILED',
        'The Holonomy module host returned metadata-only bytes for a source request',
        { diagnosticCode: 'HOST_READ_FAILED', url }
      )
    }
    return true
  }

  private invalidHostMetadataOnly(url: string) {
    return new HolonomyModuleLoaderError(
      'ERR_HOLONOMY_MODULE_SOURCE_INVALID',
      'Invalid Host module metadata restriction',
      { diagnosticCode: 'INVALID_SOURCE_BYTES', url }
    )
  }

  private canonicalizeHostSourceUrl(value: string | undefined, requestedUrl: string) {
    if (value === undefined) return requestedUrl
    try {
      if (typeof value !== 'string' || !SCHEME.test(value)) {
        throw new Error('invalid canonical URL')
      }
      const parsed = new URL(value)
      const requested = new URL(requestedUrl)
      if (
        parsed.toString() !== value ||
        parsed.search !== requested.search ||
        parsed.href.includes('?') !== requested.href.includes('?') ||
        parsed.hash !== '' ||
        parsed.href.endsWith('#') !== requested.href.endsWith('#') ||
        this.canonicalizeModuleUrl(value, this.rootUrl, false) !== value
      ) {
        throw new Error('invalid canonical URL')
      }
      return value
    } catch {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_SOURCE_INVALID',
        `Invalid Host canonical module URL for ${requestedUrl}`,
        { diagnosticCode: 'INVALID_URL', url: requestedUrl }
      )
    }
  }

  private async readHostSource(url: string, purpose: ModuleReadPurpose) {
    let pending: ReturnType<HostModuleLoaderPort['readModule']>
    try {
      this.invokingHostPort = true
      pending = this.port.readModule(url, this.hostReadContexts[purpose])
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
    if (extension !== '' && !['.cjs', '.js', '.mjs', ...(this.allowJsonModules ? ['.json'] : [])].includes(extension)) {
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
    return (await this.findPackageScope(url, transaction))?.type ?? 'commonjs'
  }

  private async loadModule(
    url: string,
    transaction: LoaderTransaction
  ): Promise<MutablePlannedModule | OpaqueExternalModule> {
    const requestedUrl = url
    url = this.knownCanonicalUrl(url)
    let cached = this.moduleCache.get(url)
    if (cached != null) {
      this.accountModule(transaction, url)
      if (
        !isOpaqueExternalModule(cached) && cached.format !== 'synthetic' &&
        (!this.moduleGrantUrls.has(requestedUrl) || this.sourceCache.get(url)?.metadataOnly === true)
      ) {
        const granted = await this.readVerifiedSource(requestedUrl, transaction)
        if (granted == null) {
          throw new HolonomyModuleLoaderError(
            'ERR_HOLONOMY_MODULE_HOST_READ_FAILED',
            'The Holonomy module host did not grant source access',
            { diagnosticCode: 'HOST_READ_FAILED', url: requestedUrl }
          )
        }
        if (granted.canonicalUrl !== url) {
          throw new HolonomyModuleLoaderError(
            'ERR_HOLONOMY_MODULE_SOURCE_INVALID',
            `Host module canonical identity changed for ${requestedUrl}`,
            { diagnosticCode: 'INVALID_URL', url: requestedUrl }
          )
        }
      }
      return cached
    }
    if (this.closureExternalUrls.has(url)) {
      this.accountModule(transaction, url)
      const external: OpaqueExternalModule = { kind: 'opaque-external', url }
      this.publishModule(transaction, url, external)
      return external
    }
    if (Object.hasOwn(this.port.syntheticNodeModules, url)) {
      this.accountModule(transaction, url)
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
    const source = await this.readVerifiedSource(requestedUrl, transaction)
    if (source == null) {
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_NOT_FOUND',
        `Cannot load Holonomy module ${url}`,
        { url }
      )
    }
    url = source.canonicalUrl
    this.accountModule(transaction, url)
    cached = this.moduleCache.get(url)
    if (cached != null) return cached
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
      if (
        dependency.specifier == null ||
        dependency.kind === 'dynamic-import' && !this.captureDynamicImports
      ) {
        module.dependencies.push({
          interop: null,
          kind: dependency.kind,
          resolvedUrl: null,
          specifier: dependency.specifier
        })
        continue
      }
      const mode: ModuleResolutionMode = dependency.kind.startsWith('require') ? 'require' : 'import'
      let resolvedUrl = await this.resolveInternal(dependency.specifier, url, mode, transaction)
      const opaqueExternal = this.closureExternalUrls.has(resolvedUrl)
      if (opaqueExternal) {
        transaction.externalReferences.push({
          kind: dependency.kind,
          parentUrl: url,
          specifier: dependency.specifier,
          url: resolvedUrl
        })
      }
      const target = dependency.kind === 'require-resolve'
        ? undefined
        : await this.loadModule(resolvedUrl, transaction)
      if (target != null) resolvedUrl = target.url
      if (dependency.kind === 'require-resolve' && this.closureExternalClassifier != null && !opaqueExternal) {
        const resolvedSource = await this.readVerifiedSource(resolvedUrl, transaction)
        if (resolvedSource == null) {
          throw new HolonomyModuleLoaderError(
            'ERR_HOLONOMY_MODULE_NOT_FOUND',
            `Cannot load Holonomy module ${resolvedUrl}`,
            { url: resolvedUrl }
          )
        }
        resolvedUrl = resolvedSource.canonicalUrl
      }
      resolvedUrl = this.knownCanonicalUrl(resolvedUrl)
      if (
        dependency.kind === 'require' && target != null && !isOpaqueExternalModule(target) && target.format === 'module'
      ) {
        throw new RequireEsmError(resolvedUrl)
      }
      const targetFormat = opaqueExternal
        ? undefined
        : target != null && !isOpaqueExternalModule(target)
        ? target.format
        : (Object.hasOwn(this.port.syntheticNodeModules, resolvedUrl)
          ? 'synthetic'
          : await this.moduleFormat(resolvedUrl, transaction))
      module.dependencies.push({
        interop: targetFormat == null ? null : interopForFormat(targetFormat),
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
        aliasKeys: new Set(),
        externalReferences: [],
        moduleGrantKeys: new Set(),
        moduleKeys: new Set(),
        moduleUrls: new Set(),
        negativeSourceKeys: new Set(),
        packageKeys: new Set(),
        packageTargetSteps: 0,
        resolutionKeys: new Set(),
        sourceBytes: new Map(),
        sourceKeys: new Set(),
        sourcePriorValues: new Map(),
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
    for (const key of transaction.moduleGrantKeys) this.moduleGrantUrls.delete(key)
    for (const key of transaction.aliasKeys) this.aliasCache.delete(key)
    for (const key of transaction.resolutionKeys) this.resolutionCache.delete(key)
    for (const key of transaction.moduleKeys) this.moduleCache.delete(key)
    for (const key of transaction.packageKeys) this.packageCache.delete(key)
    for (const key of transaction.sourceKeys) this.sourceCache.delete(key)
    for (const [key, prior] of transaction.sourcePriorValues) this.sourceCache.set(key, prior)
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
    module: MutablePlannedModule | OpaqueExternalModule
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

  private replaceSource(transaction: LoaderTransaction, key: string, source: VerifiedSource) {
    const prior = this.sourceCache.get(key)
    if (prior == null) return this.publishSource(transaction, key, source)
    if (!transaction.sourceKeys.has(key) && !transaction.sourcePriorValues.has(key)) {
      transaction.sourcePriorValues.set(key, prior)
    }
    this.sourceCache.set(key, source)
  }

  private publishModuleGrant(transaction: LoaderTransaction, requestedUrl: string, canonicalUrl: string) {
    for (const url of [requestedUrl, canonicalUrl]) {
      if (this.moduleGrantUrls.has(url)) continue
      this.moduleGrantUrls.add(url)
      transaction.moduleGrantKeys.add(url)
    }
  }

  private publishAlias(transaction: LoaderTransaction, url: string, canonicalUrl: string) {
    if (url === canonicalUrl || this.aliasCache.has(url)) return
    if (this.aliasCache.size >= MAX_SOURCE_ALIASES) {
      throw this.resourceExhausted('source aliases', url)
    }
    this.aliasCache.set(url, canonicalUrl)
    transaction.aliasKeys.add(url)
  }

  private knownCanonicalUrl(url: string) {
    return this.aliasCache.get(url) ?? url
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
    if (!this.invokingHostPort && this.closureHostReads === 0) return
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
      if (isOpaqueExternalModule(module)) continue
      reachable.add(url)
      for (const dependency of module.dependencies) {
        if (dependency.kind !== 'require-resolve' && dependency.resolvedUrl != null) {
          pending.push(dependency.resolvedUrl)
        }
      }
    }
    return reachable
  }

  private snapshotModule(module: MutablePlannedModule | OpaqueExternalModule | undefined): PlannedModule {
    if (module == null || isOpaqueExternalModule(module)) {
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
    if (Object.hasOwn(this.port.syntheticNodeModules, url) || SYNTHETIC_SCHEME.test(url)) {
      return this.resolveSynthetic(url)
    }
    const requestedUrl = this.canonicalizeModuleUrl(url, this.rootUrl, false)
    const canonicalUrl = this.knownCanonicalUrl(requestedUrl)
    this.assertCachedModuleGrant(requestedUrl, canonicalUrl)
    return canonicalUrl
  }

  private assertCachedModuleGrant(requestedUrl: string, canonicalUrl: string) {
    const source = this.sourceCache.get(canonicalUrl)
    if (source == null || this.moduleGrantUrls.has(requestedUrl) && !source.metadataOnly) return
    throw new HolonomyModuleLoaderError(
      'ERR_HOLONOMY_MODULE_HOST_READ_FAILED',
      'The Holonomy module host did not grant source access',
      { diagnosticCode: 'HOST_READ_FAILED', url: requestedUrl }
    )
  }

  private resolutionKey(parentUrl: string, mode: ModuleResolutionMode, specifier: string) {
    return `${mode}\0${parentUrl}\0${specifier}`
  }

  private resolvePlanned(specifier: string, parentUrl: string, mode: ModuleResolutionMode) {
    const resolved = this.resolutionCache.get(this.resolutionKey(parentUrl, mode, specifier))
    if (resolved != null) return this.knownCanonicalUrl(resolved)
    throw new HolonomyModuleLoaderError(
      'ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED',
      'CommonJS require requests must be admitted while building the module plan',
      { specifier, url: parentUrl }
    )
  }

  private cachedModule(url: string) {
    const module = this.moduleCache.get(url)
    if (module != null && !isOpaqueExternalModule(module)) return module
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
