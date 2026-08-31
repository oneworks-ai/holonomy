export type NetworkLimitNameV2 =
  | 'maxChunkBytes'
  | 'maxConcurrentConnections'
  | 'maxHeaderBytes'
  | 'maxHeaders'
  | 'maxRedirects'
  | 'maxRequestBodyBytes'
  | 'maxResponseBodyBytes'
  | 'maxUrlBytes'
  | 'socketTimeoutMs'

export type NetworkSandboxV2 =
  | Readonly<{ access: 'none' }>
  | Readonly<{
    access: 'mockOnly' | 'restricted'
    allowedOrigins: readonly string[]
    allowedSchemes: readonly ('http' | 'https')[]
    allowPrivateNetwork: boolean
    limits: Readonly<Record<NetworkLimitNameV2, number>>
    requestBodyInspection:
      | Readonly<{ access: 'none' }>
      | Readonly<{ access: 'bounded'; maxBytes: number; maxReadsPerRuntime: number }>
  }>

export type FilesystemRightV2 =
  | 'create'
  | 'delete'
  | 'list'
  | 'move'
  | 'read'
  | 'watch'
  | 'write'

export interface FilesystemRootV2 {
  readonly rights: readonly FilesystemRightV2[]
  readonly rootId: string
  readonly symlinks: 'deny' | 'withinRoot'
  readonly virtualUrl: `holo-fs://${string}/`
}

export interface FilesystemLimitsV2 {
  readonly maxDirectoryEntries: number
  readonly maxOpenHandles: number
  readonly maxQueuedEvents: number
  readonly maxReadBytes: number
  readonly maxWatchers: number
  readonly maxWriteBytes: number
}

export type FilesystemSandboxV2 =
  | Readonly<{ access: 'none' }>
  | Readonly<{
    access: 'sandboxed'
    limits: FilesystemLimitsV2
    roots: readonly FilesystemRootV2[]
  }>

export type CodeKindPolicyV2 =
  | Readonly<{ access: 'none' }>
  | Readonly<{
    access: 'controlled'
    decisionTimeoutMs: number
    maxOperations: number
    maxSourceBytes: number
  }>

export interface CodeGenerationSandboxV2 {
  readonly dynamicImport: CodeKindPolicyV2
  readonly strings: CodeKindPolicyV2
  readonly wasm: CodeKindPolicyV2
}

export interface InspectorSandboxV2 {
  readonly callFunctionOn: boolean
  readonly compileScript: boolean
  readonly evaluate: boolean
  readonly runScript: boolean
  readonly setScriptSource: boolean
}
