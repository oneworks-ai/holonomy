import type { EventEmitter } from 'node:events'

import type { NodeNetworkRuleSet, NodeRuntimeSandboxPlan, NodeRuntimeSandboxPolicy } from './node-network-types.mjs'

export type JsonValue = boolean | null | number | string | JsonValue[] | { readonly [key: string]: JsonValue }

export interface NodeRuntimeModule {
  readonly source: string
  readonly url: string
}

export interface NodeRuntimeSession {
  readonly argv?: readonly string[]
  readonly entryUrl: string
  readonly env?: Readonly<Record<string, string>>
  readonly inspector?: {
    readonly enabled?: boolean
    readonly waitForDebugger?: boolean
  }
  readonly moduleRootUrl?: string
  readonly networkRules?: NodeNetworkRuleSet
  readonly runtimeModules?: readonly NodeRuntimeModule[]
  readonly sandboxPlan?: NodeRuntimeSandboxPlan
  readonly sandboxPolicy?: NodeRuntimeSandboxPolicy
  readonly syntheticModules?: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>
  readonly userEntryUrl?: string
  readonly userModules: readonly NodeRuntimeModule[]
}

export interface NodeRuntimeStatus {
  readonly engineGate:
    | null
    | Readonly<{
      readonly installed: boolean
      readonly mode: 'generation-level' | 'native-per-compilation'
      readonly stringsCallbacks: number
      readonly wasmCallbacks: number
    }>
  readonly generation: number
  readonly inspectorUrl: null | string
  readonly pid: number
  readonly rulesRevision: number
  readonly state: string
}

export interface NodeRuntimeExitEvent {
  readonly code: number | null
  readonly generation: number
  readonly signal: string | null
}

export interface NodeEngineGateRequestV1 {
  readonly callsite?: Readonly<{ column?: number; line?: number; moduleUrl: string }>
  readonly codeKind: 'module' | 'strings' | 'wasm'
  readonly entryDetail?: Readonly<{
    readonly kind:
      | 'debuggerSetScriptSource'
      | 'dynamicImport'
      | 'inspectorCallFunction'
      | 'inspectorCompile'
      | 'inspectorEvaluate'
      | 'inspectorRunScript'
    readonly source: 'inspector' | 'loader' | 'trustedWrapper'
  }>
  readonly metadataSupport: Readonly<{
    readonly callsite: 'exact' | 'unavailable'
    readonly entryDetail: 'exact' | 'unavailable'
    readonly origin: 'exact' | 'unavailable'
    readonly source: 'available' | 'unavailable'
  }>
  readonly operation:
    | 'runtime.code.generate.strings'
    | 'runtime.code.generate.wasm'
    | 'runtime.module.import'
  readonly origin?: string
  readonly requestId: string
  readonly runtime: Readonly<{
    readonly generation: number
    readonly policyDigest: string
    readonly processId: string
  }>
  readonly schemaVersion: 1
  readonly signal: AbortSignal
  readonly sourceReader?: Readonly<{
    read(options: Readonly<{ maxBytes: number }>): Promise<Uint8Array>
  }>
  readonly sourceBytes?: number
  readonly sourceSha256?: string
}

export interface NodeRuntimeObserverEventV1 {
  readonly correlationId?: string
  readonly event:
    | 'gc.completed'
    | 'memory.pressure'
    | 'observer.overflow'
    | 'promise.rejected'
    | 'runtime.exception'
    | 'runtime.terminated'
    | 'script.compiled'
    | 'script.execution-finished'
    | 'script.execution-started'
  readonly generation: number
  readonly observedAt: number
  readonly payload: Readonly<Record<string, JsonValue>>
  readonly schemaVersion: 1
  readonly sequence: number
}

export interface NodeRuntimeObserverBindingV1 {
  readonly bindingId: string
  readonly observer: (event: NodeRuntimeObserverEventV1) => Promise<void> | void
  readonly ownerId: string
  readonly registration: Readonly<{
    readonly acceptHighCost?: boolean
    readonly callbackTimeoutMs?: number
    readonly events: readonly Exclude<NodeRuntimeObserverEventV1['event'], 'observer.overflow'>[]
    readonly maxQueuedEvents?: number
  }>
  readonly version: string
}

export declare class NodeRuntimeSupervisor extends EventEmitter {
  constructor(options?: {
    readonly engineGate?: (request: Readonly<NodeEngineGateRequestV1>) =>
      | Promise<Readonly<{ action: 'allow' } | { action: 'deny'; reasonCode: string }>>
      | Readonly<{ action: 'allow' } | { action: 'deny'; reasonCode: string }>
    readonly observerBindings?: readonly NodeRuntimeObserverBindingV1[]
    readonly observerHostCaps?: Readonly<{
      readonly maxObserverCallbackMs: number
      readonly maxQueuedEvents: number
    }>
    readonly requestTimeoutMs?: number
    readonly sourceReaderHostCaps?: Readonly<{
      readonly capabilityName?: 'host.diagnostics.source.read'
      readonly maxReadBytes: number
    }>
  })
  readonly generation: number
  readonly state: string
  restart(session?: NodeRuntimeSession): Promise<NodeRuntimeStatus>
  setRules(rules: NodeNetworkRuleSet, revision?: number): Promise<{ readonly revision: number }>
  start(session: NodeRuntimeSession): Promise<NodeRuntimeStatus>
  status(): Promise<NodeRuntimeStatus | { readonly generation: number; readonly state: string }>
  stop(): Promise<void>
}

export declare function normalizeNodeRuntimeSession(session: NodeRuntimeSession): Readonly<NodeRuntimeSession>
