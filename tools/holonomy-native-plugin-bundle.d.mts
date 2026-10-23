import type { RuntimePluginBundle } from '@holonomyjs/runtime/app/plugin-types'
import type { NativeSourceReader } from './holonomy-native-source-reader.mjs'

export interface PreparedNativeHolonomyRuntimePlugins {
  readonly bundles: readonly RuntimePluginBundle[]
  readonly configPath: string
}

export function prepareHolonomyRuntimePluginsNative(
  input: string | undefined,
  options: {
    readonly reader: Pick<
      NativeSourceReader,
      'statPrivate' | 'readPrivate' | 'capturePrivate' | 'openPrivatePackage' | 'readPrivatePackage'
    >
    readonly allowedAbsoluteRoots?: readonly string[]
    readonly cwd?: string
  }
): Promise<PreparedNativeHolonomyRuntimePlugins>
