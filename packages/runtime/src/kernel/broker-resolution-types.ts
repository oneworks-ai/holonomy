import type {
  CapabilityProviderAuthorityV1,
  CapabilityProviderTerminalV1,
  HoloInvocationContextV1
} from './broker-types.js'
import type { ResolutionAdmissionTokenV1, ResolutionEvidenceV1 } from './resolution-types.js'
import type { CanonicalResourceV1 } from './resource-types.js'

export interface CapabilityProviderResolutionRequestV1 {
  readonly evidence: ResolutionEvidenceV1
  readonly reason: 'filesystemTarget' | 'networkAddress' | 'opaqueRebind'
  readonly resolved: CanonicalResourceV1
  /** Resolution-only work must not have produced a Guest-visible or external business side effect. */
  readonly sideEffectCount: 0
  verify(): CapabilityProviderResolutionVerificationV1 | Promise<CapabilityProviderResolutionVerificationV1>
}

export interface CapabilityProviderResolutionVerificationV1 {
  readonly evidence: ResolutionEvidenceV1
  readonly resolved: CanonicalResourceV1
}

export interface CapabilityProviderResolutionPlanV1<THostContext = unknown> {
  readonly requests: readonly CapabilityProviderResolutionRequestV1[]
  dispose?(): void | Promise<void>
  execute(
    context: HoloInvocationContextV1<THostContext>,
    authorities: readonly CapabilityProviderAuthorityV1[],
    tokens: readonly ResolutionAdmissionTokenV1[]
  ): CapabilityProviderTerminalV1 | Promise<CapabilityProviderTerminalV1>
}

export interface AdmittedProviderResolutionV1<THostContext> {
  readonly authority: CapabilityProviderAuthorityV1
  readonly context: HoloInvocationContextV1<THostContext>
  readonly token: ResolutionAdmissionTokenV1
  consume(verification: CapabilityProviderResolutionVerificationV1): void
  dispose(): void
}

export interface CapabilityProviderResolutionAdmitterV1<THostContext> {
  admit(request: CapabilityProviderResolutionRequestV1): Promise<AdmittedProviderResolutionV1<THostContext>>
  admitSync(request: CapabilityProviderResolutionRequestV1): AdmittedProviderResolutionV1<THostContext>
}
