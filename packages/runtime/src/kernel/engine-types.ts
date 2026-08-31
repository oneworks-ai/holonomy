export type EngineGateOperationV1 =
  | 'runtime.code.generate.strings'
  | 'runtime.code.generate.wasm'
  | 'runtime.module.import'

export interface EngineGateMetadataSupportV1 {
  readonly callsite: 'exact' | 'unavailable'
  readonly entryDetail: 'exact' | 'unavailable'
  readonly origin: 'exact' | 'unavailable'
  readonly source: 'available' | 'unavailable'
}

export interface EngineHookCapabilityProbeV1 {
  readonly engine: 'android-embedded-v8' | 'node-vm'
  readonly metadata: EngineGateMetadataSupportV1
  readonly provenance: Readonly<{
    generationLevel: 'behavioralProbe'
    metadata: 'profileStaticUnsupported'
    perCompilationCallback: 'profileStaticUnsupported'
  }>
  readonly schemaVersion: 1
  readonly strings: Readonly<{
    generationLevelDeny: boolean
    perCompilationCallback: boolean
  }>
  readonly wasm: Readonly<{
    generationLevelDeny: boolean
    perCompilationCallback: boolean
  }>
}

export interface EngineGateRequestMetadataV1 {
  readonly callsite?: Readonly<{ column?: number; line?: number; moduleUrl: string }>
  readonly codeKind: 'module' | 'strings' | 'wasm'
  readonly entryDetail?: Readonly<{
    kind:
      | 'debuggerSetScriptSource'
      | 'dynamicImport'
      | 'inspectorCallFunction'
      | 'inspectorCompile'
      | 'inspectorEvaluate'
      | 'inspectorRunScript'
    source: 'inspector' | 'loader' | 'trustedWrapper'
  }>
  readonly metadataSupport: EngineGateMetadataSupportV1
  readonly operation: EngineGateOperationV1
  readonly origin?: string
  readonly requestId: string
  readonly runtime: Readonly<{ generation: number; policyDigest: string; processId: string }>
  readonly schemaVersion: 1
  readonly sourceBytes?: number
  readonly sourceSha256?: string
}

export type EngineGateDecisionV1 =
  | Readonly<{ action: 'allow' }>
  | Readonly<{ action: 'deny'; reasonCode: string }>
