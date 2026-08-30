import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'

export interface RuntimePluginDefinitionV1 {
  readonly bundleSha256: string
  readonly config: JsonValueV1
  readonly entryUrl: `holo-plugins:///${string}`
  readonly exportName: string
  readonly instanceId: string
}

export interface RuntimePluginFileV1 {
  readonly sha256: string
  readonly source: string
  readonly url: `holo-plugins:///${string}`
}

export interface RuntimePluginBundleV1 extends RuntimePluginDefinitionV1 {
  readonly files: readonly RuntimePluginFileV1[]
  readonly rootUrl: `holo-plugins:///${string}/`
  readonly schemaVersion: 1
}

export interface RuntimePluginGraphSnapshotV1 {
  readonly closed: boolean
  readonly instances: readonly Readonly<{
    readonly bundleSha256: string
    readonly exportName: string
    readonly instanceId: string
  }>[]
  readonly pluginGraphRevision: number
}

export interface RuntimePluginModuleNamespaceV1 {
  readonly [name: string]: unknown
}

export interface RuntimePluginAppOptionsV1 {
  readonly createContextService?: (
    definition: RuntimePluginDefinitionV1,
    lifecycle: RuntimePluginContextLifecycleV1
  ) => Readonly<Record<string, unknown>>
  readonly importModule: (entryUrl: string) => Promise<RuntimePluginModuleNamespaceV1>
  readonly drain?: (revision: number) => Promise<void>
  readonly initialRevision?: number
  readonly publish?: (
    revision: number,
    definitions: readonly RuntimePluginDefinitionV1[]
  ) => void
}

export interface RuntimePluginContextLifecycleV1 {
  readonly instanceId: string
  registerDispose(dispose: () => void | Promise<void>): void
}
