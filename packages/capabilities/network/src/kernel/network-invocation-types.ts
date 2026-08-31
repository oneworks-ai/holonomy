import type { NetworkResourceV1 } from '@holonomyjs/runtime/kernel/resource-types'

export type NetworkHeaderViewV1 =
  | Readonly<{
    index: number
    name: string
    visibility: 'visible'
    value: string
  }>
  | Readonly<{
    index: number
    name: string
    visibility: 'redacted'
  }>

export type NetworkQueryViewV1 =
  | Readonly<{
    index: number
    key: string
    visibility: 'visible'
    value: string
  }>
  | Readonly<{
    index: number
    key: string
    visibility: 'redacted'
  }>

export type NetworkRequestBodyMetadataV1 =
  | Readonly<{ kind: 'none'; length: 0 }>
  | Readonly<{ kind: 'buffered'; length: number; sha256: string }>

export interface NetworkInvocationSnapshotV1 {
  readonly body: NetworkRequestBodyMetadataV1
  readonly headerDigest: string
  readonly headers: readonly NetworkHeaderViewV1[]
  readonly hop: number
  readonly logicalRequestId: string
  readonly method: string
  readonly query: readonly NetworkQueryViewV1[]
  readonly queryDigest: string
  readonly resource: NetworkResourceV1
  readonly schemaVersion: 1
}

export interface NetworkRedirectInvocationV1 {
  readonly bodyReplay: 'none' | 'same-buffered-body'
  readonly fromHop: number
  readonly fromRequest: NetworkInvocationSnapshotV1
  readonly logicalRequestId: string
  readonly methodRewritten: boolean
  readonly status: 301 | 302 | 303 | 307 | 308
  readonly toHop: number
  readonly toRequest: NetworkInvocationSnapshotV1
}
