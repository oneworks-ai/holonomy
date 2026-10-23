import type { HolonomyCliOptions } from './holonomy-cli-options.mjs'
import type { NativeSourceReader } from './holonomy-native-source-reader.mjs'
import type { prepareHolonomyRuntimePlugins } from './holonomy-plugin-bundle.mjs'

export interface HolonomyLaunchSnapshot {
  capabilityRuntime?: Readonly<Record<string, unknown>>
  entryUrl: string
  fixture?: { kind: 'conformance-network-v1' }
  inspectorMode: 'break' | 'enabled' | 'off'
  isolation: 'runtime' | 'isolatedProcess'
  launch: Readonly<Record<string, unknown>>
  networkRuleSet?: Record<string, unknown>
  pluginConfigPath?: string
  runtimePlugins?: readonly import('@holonomyjs/runtime/app/plugin-types').RuntimePluginBundle[]
  sandboxPolicy: Readonly<Record<string, unknown>>
  target: 'android' | 'node' | 'native'
}

export function prepareHolonomyLaunchSnapshot(
  command: 'run' | 'test',
  options: HolonomyCliOptions,
  dependencies?: {
    cwd?: string
    home?: string
    createNativeSourceReader?: (options: {
      binaryPath: string
      workspaceRoot: string
      signal?: AbortSignal
    }) => Promise<NativeSourceReader>
    randomUUID?: () => string
    nativeSourceExecutablePath?: string
    signal?: AbortSignal
    readCapabilityRuntime?: (path: string) => Record<string, unknown>
    readNetworkRules?: (path: string) => Record<string, unknown>
    readSandboxPolicy?: (path: string) => Record<string, unknown>
    prepareRuntimePlugins?: typeof prepareHolonomyRuntimePlugins
  }
): Promise<HolonomyLaunchSnapshot>

export function readHolonomySandboxPolicy(
  path: string,
  options?: { cwd?: string }
): Readonly<Record<string, unknown>>

export function readHolonomyCapabilityRuntime(
  path: string,
  options?: { cwd?: string }
): Readonly<Record<string, unknown>>
