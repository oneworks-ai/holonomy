export type ModuleResolutionMode = 'import' | 'require'

export type ModuleReadPurpose = 'module' | 'packageMetadata'

export type PlannedModuleFormat =
  | 'commonjs'
  | 'json'
  | 'module'
  | 'synthetic'

export type ModuleDependencyKind =
  | 'dynamic-import'
  | 'import'
  | 'require'
  | 'require-resolve'

export type ModuleDependencyInterop =
  | 'commonjs-namespace'
  | 'module-namespace'
  | 'synthetic-namespace'

export interface HostModuleSource {
  bytes: Uint8Array
  sha256: string
  /** Host-verified physical module identity when the requested URL is an alias. */
  canonicalUrl?: string
  /** Trusted Host restriction: these bytes may be consumed only as package metadata. */
  metadataOnly?: true
}

export interface HostModuleReadLoaderFacade {
  createPlan(entrySpecifier: string, options?: CreateModulePlanOptions): Promise<never>
  createSourceClosure(entrySpecifier: string, options: CreateModuleSourceClosureOptions): Promise<never>
  load(canonicalUrl: string): Promise<never>
  resolve(
    specifier: string,
    parentUrl?: string,
    mode?: ModuleResolutionMode
  ): Promise<never>
}

export interface HostModuleReadContext {
  /** A deterministic rejection facade for forbidden loader reentry, including after `await`. */
  readonly loader: HostModuleReadLoaderFacade
  readonly purpose: ModuleReadPurpose
}

export interface SyntheticNodeModuleDefinition {
  /** Engine-provided export names. Include `default` when it is available. */
  exportNames: readonly string[]
}

export interface HostModuleLoaderPort {
  /** Reads a canonical URL under the configured root. `null` is the only not-found signal. */
  readModule(
    canonicalUrl: string,
    context: HostModuleReadContext
  ): HostModuleSource | null | Promise<HostModuleSource | null>

  /** Declares the complete set of engine-provided `node:` modules. */
  syntheticNodeModules: Readonly<Record<string, SyntheticNodeModuleDefinition>>
}

export interface HolonomyModuleLoaderLimits {
  readonly maxAstDepth: number
  readonly maxAstNodes: number
  readonly maxDependenciesPerModule: number
  readonly maxModules: number
  readonly maxSourceBytes: number
  readonly maxTotalSourceBytesPerPlan: number
}

export const DEFAULT_HOLONOMY_MODULE_LOADER_LIMITS: Readonly<HolonomyModuleLoaderLimits> = Object.freeze({
  maxAstDepth: 8_192,
  maxAstNodes: 250_000,
  maxDependenciesPerModule: 4_096,
  maxModules: 4_096,
  maxSourceBytes: 8 * 1_024 * 1_024,
  maxTotalSourceBytesPerPlan: 32 * 1_024 * 1_024
})

export interface HolonomyModuleLoaderOptions {
  /** Immutable trusted Host graph mode; ordinary execution leaves dynamic imports lazy. */
  captureDynamicImports?: boolean
  /** Absolute hierarchical root; its scheme is host-defined (for example `memory://device/bundle/`). */
  rootUrl: string
  /** Optional trusted digest manifest keyed by canonical module URL. */
  integrity?: Readonly<Record<string, string>>
  /** Frozen fail-closed budgets applied independently to every public plan/load transaction. */
  limits?: Partial<HolonomyModuleLoaderLimits>
  /** Enables workspace source conditions only when a host compiled those assets. */
  resolutionProfile?: 'production' | 'source'
  allowJsonModules?: boolean
}

export interface CreateModulePlanOptions {
  mode?: ModuleResolutionMode
  /** Canonical importer URL. Defaults to a virtual module below `rootUrl`. */
  parentUrl?: string
}

export interface CreateModuleSourceClosureOptions extends CreateModulePlanOptions {
  /** Trusted Host classification of reserved node:/holo: names and bare Node builtins. */
  isExternalModule(specifier: string): boolean
}

/** A verified positive read, including package.json metadata and resolve-only targets. */
export interface ModuleSourceClosureRead {
  readonly url: string
  readonly byteLength: number
  readonly sha256: string
  /** Exact copied Host bytes; base64 keeps this snapshot immutable across the JS/Host boundary. */
  readonly bytesBase64: string
  /** Present only for a Host-restricted package metadata read. */
  readonly metadataOnly?: true
}

export interface ModuleSourceClosureAlias {
  readonly url: string
  readonly canonicalUrl: string
}

export interface ModuleSourceClosureExternalReference {
  readonly parentUrl: string
  readonly specifier: string
  readonly url: string
  readonly kind: ModuleDependencyKind | 'entry'
}

/** Non-executable input to a Host that performs its own final engine admission. */
export interface ModuleSourceClosure {
  readonly kind: 'source-closure'
  readonly entryUrl: string
  readonly rootUrl: string
  /** Positive Host reads whose requested URL differs from its canonical identity. */
  readonly aliases: readonly ModuleSourceClosureAlias[]
  readonly reads: readonly ModuleSourceClosureRead[]
  readonly externalReferences: readonly ModuleSourceClosureExternalReference[]
}

export interface ModuleDependency {
  interop: ModuleDependencyInterop | null
  kind: ModuleDependencyKind
  /** `null` identifies a dynamic import deferred until runtime, including a literal specifier. */
  resolvedUrl: string | null
  /** `null` identifies a runtime-resolved non-literal dynamic import. */
  specifier: string | null
}

export interface PlannedModule {
  dependencies: readonly ModuleDependency[]
  exportNames: readonly string[]
  format: PlannedModuleFormat
  /** `null` for engine-provided synthetic modules. */
  sha256: string | null
  /** Verified UTF-8 source. `null` for engine-provided synthetic modules. */
  source: string | null
  url: string
}

export interface ModulePlan {
  entryUrl: string
  /** Sorted by canonical URL. Dependency lists preserve source order. */
  modules: readonly PlannedModule[]
  rootUrl: string
}

export type ModuleEvaluationState = 'evaluated' | 'evaluating'

export interface ModuleEvaluationCacheEntry {
  exports: unknown
  format: PlannedModuleFormat
  state: ModuleEvaluationState
  url: string
}

export interface PlannedRequireRequest {
  cached: ModuleEvaluationCacheEntry | undefined
  module: PlannedModule
  url: string
}

export interface ModuleRequireCache {
  delete(url: string): boolean
  get(url: string): ModuleEvaluationCacheEntry | undefined
  keys(): readonly string[]
}

/**
 * Engine-facing createRequire contract. `request()` resolves and validates a
 * CJS load without evaluating it; the engine owns evaluation and reports the
 * result through the loader's evaluation-cache methods.
 */
export interface PlannedRequire {
  readonly cache: ModuleRequireCache
  request(specifier: string): PlannedRequireRequest
  resolve(specifier: string): string
}

export type PluginActivate = (context: unknown) => unknown
