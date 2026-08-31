import type {
  FilesystemResourceV1,
  NetworkResourceV1,
  OpaqueHandleResourceV1,
  ProcessNetworkEndpointResourceV1
} from './resource-types.js'

export interface NetworkAddressEvidenceV1 {
  readonly addresses: readonly string[]
  readonly expiresAtMonotonicMs: number
  readonly kind: 'networkAddress'
  readonly resolverGeneration: number
}
export interface FilesystemTargetEvidenceV1 {
  readonly ancestorIdentityDigests: readonly string[]
  readonly kind: 'filesystemTarget'
  readonly rootId: string
  readonly targetIdentityDigest: string
  readonly targetType: 'directory' | 'file' | 'missing' | 'symlink'
}
export interface OpaqueIdentityEvidenceV1 {
  readonly bridgeIdentityDigest: string
  readonly generation: number
  readonly kind: 'opaqueIdentity'
  readonly rightsDigest: string
}
export type ResolutionEvidenceV1 =
  | FilesystemTargetEvidenceV1
  | NetworkAddressEvidenceV1
  | OpaqueIdentityEvidenceV1

export interface ResolutionEvidenceBindingV1 {
  readonly bindingId: string
  readonly evidenceDigest: string
  readonly kind: ResolutionEvidenceV1['kind']
}

interface ChallengeBaseV1 {
  readonly challengeId: string
  readonly parentRequestId: string
  readonly schemaVersion: 1
  readonly sequence: number
}

export type ResolvedResourceChallengeV1 =
  | Readonly<
    ChallengeBaseV1 & {
      evidence: ResolutionEvidenceBindingV1 & { readonly kind: 'networkAddress' }
      reason: 'networkAddress'
      requested: NetworkResourceV1 | ProcessNetworkEndpointResourceV1
      resolved: NetworkResourceV1 | ProcessNetworkEndpointResourceV1
    }
  >
  | Readonly<
    ChallengeBaseV1 & {
      evidence: ResolutionEvidenceBindingV1 & { readonly kind: 'filesystemTarget' }
      reason: 'filesystemTarget'
      requested: FilesystemResourceV1
      resolved: FilesystemResourceV1
    }
  >
  | Readonly<
    ChallengeBaseV1 & {
      evidence: ResolutionEvidenceBindingV1 & { readonly kind: 'opaqueIdentity' }
      reason: 'opaqueRebind'
      requested: OpaqueHandleResourceV1
      resolved: OpaqueHandleResourceV1
    }
  >

export interface ResolutionAdmissionTokenV1 {
  readonly challengeId: string
  readonly evidenceDigest: string
  readonly expiresAtMonotonicMs: number
  readonly generation: number
  readonly invocationBindingDigest: string
  readonly parentRequestId: string
  readonly requestedSemanticDigest: string
  readonly resolvedSemanticDigest: string
  readonly sequence: number
  readonly tokenId: string
}
