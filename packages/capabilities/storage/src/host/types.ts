import type { CapabilityBrokerProviderV1 } from '@holonomyjs/runtime/kernel/broker-types'
import type { StorageHostRequestV1 } from '../kernel/storage-invocation.js'
import type { StorageLimitsV2 } from '../kernel/storage-types.js'

/** Platform I/O only: completion is delivered on the owning Host Realm thread. */
export interface StorageNativePortV1 {
  storageStart(command: string): { id: number; promise: Promise<string> }
  storageCancel(id: number): void
}

export interface StorageHostInstallationV1 {
  readonly operations: readonly string[]
  readonly limits?: Partial<StorageLimitsV2>
}

export type StorageHostPolicyV1 =
  | Readonly<{ access: 'none' }>
  | Readonly<{ access: 'sandboxed'; limits: Pick<StorageLimitsV2, 'maxPendingOperations'> }>

export interface StorageTrackedKernelV1 {
  invokeTracked(invocation: string, signal: AbortSignal): {
    result: Promise<string>
    settled: Promise<void>
  }
}

/** NativeBridge transport bytes have already been copied and encoded by the Adapter. */
export interface StorageDispatchRequestV1 extends StorageHostRequestV1 {
  readonly binary?: readonly Readonly<{ handle: string; base64: string }>[]
}

export interface StorageBinaryV1 {
  readonly handle: string
  readonly data: Uint8Array
}

export interface StorageDispatchTerminalV1 {
  readonly value:
    | Readonly<{ ok: false; error: { code: string } }>
    | Readonly<{ ok: true; value: unknown }>
  readonly binary?: readonly Readonly<{ handle: string; base64: string }>[]
}

export interface StorageHostProviderV1 {
  readonly provider: CapabilityBrokerProviderV1
  dispatch(
    request: StorageDispatchRequestV1,
    token: string,
    signal: AbortSignal,
    kernel: StorageTrackedKernelV1
  ): Promise<StorageDispatchTerminalV1>
  close(): void
}

/** Fields are optional across operations; the Kernel's operation schema validates each invocation. */
export interface StorageArgumentsV1 {
  readonly namespaceId: string
  readonly key?: string
  readonly prefix?: string
  readonly database?: string
  readonly valueByteLength?: number
  readonly valueSha256?: string
  readonly statement?: StorageStatementV1
  readonly statements?: readonly StorageStatementV1[]
}

export interface StorageStatementV1 {
  readonly sql: string
  readonly params?: readonly (null | boolean | number | string)[]
}

export interface StorageHostStateV1 {
  readonly payloads: Map<string, readonly StorageBinaryV1[]>
  readonly active: Set<number>
  closed: boolean
  occupied: number
}
