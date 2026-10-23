import type { RuntimePluginBundle } from '@holonomyjs/runtime/app/plugin-types'

export interface HolonomyPluginWatchController {
  close(): Promise<void>
}

export function startHolonomyPluginWatch(options: {
  readonly client: {
    replaceRuntimePlugins(
      processId: string,
      input: { expectedGeneration: number; runtimePlugins: readonly RuntimePluginBundle[] },
      expectedRevision: number,
      idempotencyKey: string
    ): Promise<{ value: { operation: { id: string } } }>
  }
  readonly configPath: string
  readonly dependencies: {
    readonly cancelWatch?: (timer: unknown) => void
    readonly observeConfigFile?: (filename: string, callback: () => void) => () => void
    readonly prepareRuntimePlugins?: (
      path: string,
      options: { allowedAbsoluteRoots: readonly string[] }
    ) => Promise<{ bundles: readonly RuntimePluginBundle[] }> | { bundles: readonly RuntimePluginBundle[] }
    readonly scheduleWatch?: (callback: () => void, delay: number) => unknown
    readonly waitForOperation: (
      client: unknown,
      operationId: string,
      options: unknown
    ) => Promise<{ result: { process: { pluginGraphRevision: number } } }>
    readonly watchDirectory?: (
      directory: string,
      callback: (event: string, filename?: string) => void
    ) => { close(): void; on?(event: string, callback: () => void): unknown }
  }
  readonly io: { stderr: { write(value: string): unknown } }
  readonly pluginRoots: readonly string[]
  readonly process: { generation: number; id: string; pluginGraphRevision: number }
  readonly runtimePlugins: readonly RuntimePluginBundle[]
}): HolonomyPluginWatchController
