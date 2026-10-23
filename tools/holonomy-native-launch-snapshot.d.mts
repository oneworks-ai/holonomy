import type { HolonomyCliOptions } from './holonomy-cli-options.mjs'
import type { HolonomyLaunchSnapshot } from './holonomy-launch-snapshot.mjs'
import type { NativeSourceReader } from './holonomy-native-source-reader.mjs'

export interface HolonomyNativeSourceContext {
  readonly reader: NativeSourceReader
  readonly preparePlugins: (
    input: string,
    options?: { allowedAbsoluteRoots?: readonly string[]; cwd?: string }
  ) => Promise<{ bundles: readonly import('@holonomyjs/runtime/app/plugin-types').RuntimePluginBundle[] }>
}

export function getHolonomyNativeSourceContext(
  snapshot: HolonomyLaunchSnapshot
): HolonomyNativeSourceContext | undefined

export function prepareHolonomyNativeLaunchSnapshot(
  command: 'run' | 'test',
  options: HolonomyCliOptions,
  dependencies?: {
    cwd?: string
    createNativeSourceReader?: (options: {
      binaryPath: string
      workspaceRoot: string
      signal?: AbortSignal
    }) => Promise<NativeSourceReader>
    home?: string
    nativeSourceExecutablePath?: string
    randomUUID?: () => string
    signal?: AbortSignal
  }
): Promise<HolonomyLaunchSnapshot>
