export type ModuleResolutionMode = 'import' | 'require'

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
}

export interface HostModuleReadLoaderFacade {
  createPlan(entrySpecifier: string, options?: CreateModulePlanOptions): Promise<never>
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
}

export interface SyntheticNodeModuleDefinition {
  /** Engine-provided export names. Include `default` when it is available. */
  exportNames: readonly string[]
}

export interface HostModuleLoaderPort {
  /** Reads a canonical app URL. `null` is the only not-found signal. */
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
  /** File-like virtual root such as `app:///bundle/`. */
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

export interface ModuleDependency {
  interop: ModuleDependencyInterop | null
  kind: ModuleDependencyKind
  /** `null` identifies a runtime-resolved non-literal dynamic import. */
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
