import type { RuntimePluginBundleV1 } from '../src/runtime/plugin-types.js'

export interface PreparedHolonomyRuntimePlugins {
  readonly bundles: readonly RuntimePluginBundleV1[]
  readonly configPath: string
}

export function prepareHolonomyRuntimePlugins(
  input?: string,
  options?: { readonly allowedAbsoluteRoots?: readonly string[]; readonly cwd?: string }
): PreparedHolonomyRuntimePlugins
