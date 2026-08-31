import type { RuntimePluginBundleV1 } from '@holonomyjs/runtime/app/plugin-types'

export interface PreparedHolonomyRuntimePlugins {
  readonly bundles: readonly RuntimePluginBundleV1[]
  readonly configPath: string
}

export function prepareHolonomyRuntimePlugins(
  input?: string,
  options?: { readonly allowedAbsoluteRoots?: readonly string[]; readonly cwd?: string }
): PreparedHolonomyRuntimePlugins
