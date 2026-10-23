import type { RuntimePluginBundleV1, RuntimePluginFileV1 } from '@holonomyjs/runtime/app/plugin-types'
import type { HoloPluginConfigEntry } from './holonomy-plugin-config.mjs'

export interface PreparedHolonomyRuntimePlugins {
  readonly bundles: readonly RuntimePluginBundleV1[]
  readonly configPath: string
}

export function prepareHolonomyRuntimePlugins(
  input?: string,
  options?: { readonly allowedAbsoluteRoots?: readonly string[]; readonly cwd?: string }
): PreparedHolonomyRuntimePlugins

export function findHoloPluginDependencies(source: string): string[]

export function isTrustedRuntimePluginLibrary(specifier: string): boolean

export function createRuntimePluginBundle(
  entry: HoloPluginConfigEntry,
  resolved: Readonly<{ root: string; entryFile: string }>,
  configSchema: unknown,
  files: readonly RuntimePluginFileV1[]
): RuntimePluginBundleV1
