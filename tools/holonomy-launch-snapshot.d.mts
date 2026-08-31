import type { HolonomyCliOptions } from './holonomy-cli-options.mjs'

export interface HolonomyLaunchSnapshot {
  capabilityRuntime?: Readonly<Record<string, unknown>>
  entryUrl: string
  fixture?: { kind: 'conformance-network-v1' }
  inspectorMode: 'break' | 'enabled' | 'off'
  isolation: 'runtime' | 'isolatedProcess'
  launch: Readonly<Record<string, unknown>>
  networkRuleSet?: Record<string, unknown>
  pluginConfigPath?: string
  runtimePlugins?: readonly import('@holonomyjs/runtime/app/plugin-types').RuntimePluginBundleV1[]
  sandboxPolicy: Readonly<Record<string, unknown>>
  target: 'android' | 'node'
}

export function prepareHolonomyLaunchSnapshot(
  command: 'run' | 'test',
  options: HolonomyCliOptions,
  dependencies?: {
    randomUUID?: () => string
    readCapabilityRuntime?: (path: string) => Record<string, unknown>
    readNetworkRules?: (path: string) => Record<string, unknown>
    readSandboxPolicy?: (path: string) => Record<string, unknown>
  }
): HolonomyLaunchSnapshot

export function readHolonomySandboxPolicy(
  path: string,
  options?: { cwd?: string }
): Readonly<Record<string, unknown>>

export function readHolonomyCapabilityRuntime(
  path: string,
  options?: { cwd?: string }
): Readonly<Record<string, unknown>>
