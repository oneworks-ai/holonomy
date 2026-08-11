import type { EventEmitter } from 'node:events'

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
  readonly generation: number
  readonly inspectorUrl: null | string
  readonly pid: number
  readonly rulesRevision: number
  readonly state: string
}

export declare class NodeRuntimeSupervisor extends EventEmitter {
  constructor(options?: { readonly requestTimeoutMs?: number })
  readonly generation: number
  readonly state: string
  restart(session?: NodeRuntimeSession): Promise<NodeRuntimeStatus>
  setRules(rules: NodeNetworkRuleSet, revision?: number): Promise<{ readonly revision: number }>
  start(session: NodeRuntimeSession): Promise<NodeRuntimeStatus>
  status(): Promise<NodeRuntimeStatus | { readonly generation: number; readonly state: string }>
  stop(): Promise<void>
}

export interface NodeNetworkRule {
  readonly allowPrivateNetwork?: boolean
  readonly methods?: readonly string[]
  readonly origin: string
}

export interface NodeRuntimeNetworkAuthority {
  readonly allowedOrigins: readonly string[]
  readonly allowedSchemes?: readonly ('http' | 'https' | 'ws' | 'wss')[]
  readonly limits?: Readonly<Record<string, number>>
  readonly privateNetwork?: 'allow' | 'deny'
}

export interface NodeRuntimeSandboxLimits {
  readonly maxChunkBytes: number
  readonly maxConcurrentConnections: number
  readonly maxHeaderBytes: number
  readonly maxHeaders: number
  readonly maxRequestBodyBytes: number
  readonly maxResponseBodyBytes: number
  readonly maxUrlBytes: number
  readonly socketTimeoutMs: number
}

export type NodeRuntimeSandboxPolicy = Readonly<{
  schemaVersion: 1
  filesystem: Readonly<{ access: 'none' }>
  network:
    | Readonly<{ access: 'none' }>
    | Readonly<{
      access: 'mockOnly' | 'restricted'
      allowedOrigins: readonly string[]
      allowedSchemes: readonly ('http' | 'https')[]
      allowPrivateNetwork: boolean
      limits: NodeRuntimeSandboxLimits
    }>
}>

export interface NodeRuntimeSandboxPlan {
  readonly access: 'mockOnly' | 'none' | 'restricted'
  readonly authority?: NodeRuntimeNetworkAuthority & { readonly limits: NodeRuntimeSandboxLimits }
  readonly capabilities: readonly ('host.network.http' | 'host.network.mock')[]
  readonly policyDigest: string
  readonly principal: string
}

export interface NodeNetworkRuleSet {
  readonly mode: 'failClosed' | 'passthrough'
  readonly rules: readonly JsonValue[]
}

export declare class NodeNetworkAuthority {
  constructor(rules?: readonly NodeNetworkRule[])
  authorizeAddress(input: {
    readonly address: string
    readonly decision: { readonly allowPrivateNetwork: boolean }
  }): void
  authorizeRequest(input: { readonly method: string; readonly url: URL }): { readonly allowPrivateNetwork: boolean }
}

export interface NodeNetworkRequest {
  readonly body?: Uint8Array
  readonly headers?: readonly (readonly [string, string])[]
  readonly method?: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly url: string
}

export interface NodeNetworkResponse {
  readonly address: string
  readonly body: Uint8Array
  readonly headers: readonly (readonly [string, string])[]
  readonly status: number
  readonly statusText: string
  readonly url: string
}

export declare class NodeHttpNetworkHost {
  constructor(options: {
    readonly authority: NodeNetworkAuthority
    readonly limits?: NodeRuntimeSandboxLimits
    readonly maxResponseBytes?: number
    readonly observer?: (event: Readonly<Record<string, JsonValue>>) => void
  })
  request(input: NodeNetworkRequest): Promise<NodeNetworkResponse>
}

export declare function isPrivateAddress(address: string): boolean
export declare function normalizeNodeRuntimeSession(session: NodeRuntimeSession): Readonly<NodeRuntimeSession>
