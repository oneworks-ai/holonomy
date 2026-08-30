import { createProviderAuthorityV1 } from './broker-authority.js'
import { matchesHoloInvocationV1 } from './broker-matcher.js'
import { authorizeCapabilityInvocationV1 } from './broker-policy.js'
import { runResolutionMiddlewareAsyncV1, runResolutionMiddlewareSyncV1 } from './broker-resolution-middleware.js'
import {
  normalizeProviderResolutionEvidenceV1,
  resolutionProtocolFailureV1,
  resolutionSelectionKeyV1
} from './broker-resolution-support.js'
import type { ResolutionInputV1 } from './broker-resolution-support.js'
import type {
  AdmittedProviderResolutionV1,
  CapabilityProviderResolutionAdmitterV1,
  CapabilityProviderResolutionRequestV1,
  CapabilityProviderResolutionVerificationV1
} from './broker-resolution-types.js'
import type { HoloInvocationContextV1, HoloMiddlewareRegistrationV1 } from './broker-types.js'
import { canonicalDigest } from './canonical-json.js'
import { validateCanonicalResourceV1 } from './canonical-resource-validation.js'
import { capabilityFailure } from './errors.js'
import { normalizeResolutionAdmissionTokenV1, normalizeResolvedResourceChallengeV1 } from './resolution-challenge.js'
import { resolutionEvidenceDigestV1 } from './resolution-evidence.js'
import type { ResolutionEvidenceV1 } from './resolution-types.js'

const now = (): number => globalThis.performance?.now?.() ?? Date.now()

const resolutionMiddleware = <T>(
  input: ResolutionInputV1<T>,
  context: HoloInvocationContextV1<T>
): readonly HoloMiddlewareRegistrationV1<T>[] => {
  const hostResolution = context.resource.resolved?.kind === 'filesystem' &&
      context.resource.requested.semanticResourceDigest !== context.resource.resolved.semanticResourceDigest
    ? [
      ...input.options.initial.registrations,
      ...input.options.interceptors.snapshot()
    ].filter(item => item.matcher.phase === 'resolved')
    : []
  return Object.freeze([
    ...input.options.system,
    ...hostResolution
  ].filter(item => matchesHoloInvocationV1(item.matcher, context)))
}

export const createProviderResolutionAdmitterV1 = <THostContext>(input: ResolutionInputV1<THostContext>) => {
  let sequence = 0
  const evidenceStore = new Map<string, Readonly<{ digest: string; evidence: ResolutionEvidenceV1 }>>()

  const prepare = (request: CapabilityProviderResolutionRequestV1) => {
    if (request.sideEffectCount !== 0 || ++sequence > 32) return resolutionProtocolFailureV1(input)
    const evidence = normalizeProviderResolutionEvidenceV1(input, request.evidence)
    const evidenceDigest = resolutionEvidenceDigestV1(evidence)
    const identity = canonicalDigest([
      'resolution',
      input.context.requestId,
      sequence,
      input.context.resource.requested.semanticResourceDigest,
      request.resolved.semanticResourceDigest,
      evidenceDigest
    ])
    const challengeId = `resolution-${identity.slice(0, 32)}`
    const bindingId = `evidence-${identity.slice(0, 32)}`
    let challenge
    try {
      challenge = normalizeResolvedResourceChallengeV1({
        challengeId,
        evidence: { bindingId, evidenceDigest, kind: evidence.kind },
        parentRequestId: input.context.requestId,
        reason: request.reason,
        requested: input.context.resource.requested,
        resolved: request.resolved,
        schemaVersion: 1,
        sequence
      })
    } catch {
      return resolutionProtocolFailureV1(input)
    }
    const resolvedSelection = authorizeCapabilityInvocationV1({
      arguments: input.arguments,
      context: {
        generation: input.options.admitted.generation,
        policyDigest: input.options.policyDigest,
        principal: input.options.admitted.principal,
        processId: input.options.admitted.processId
      },
      descriptor: input.descriptor,
      deviceProviderDescriptor: input.options.admitted.configuration.deviceProviderDescriptor,
      policy: input.options.admitted.configuration.sandboxPolicy,
      preferredProviderModule: input.providerModule,
      resource: challenge.resolved,
      systemProjection: input.options.admitted.configuration.systemProjection
    })
    if (resolutionSelectionKeyV1(resolvedSelection) !== resolutionSelectionKeyV1(input.selection)) {
      capabilityFailure('capability.denied', input.context.operation, challenge.resolved.semanticResourceDigest)
    }
    const providerAuthority = createProviderAuthorityV1({
      descriptor: input.descriptor,
      generation: input.context.runtime.generation,
      processId: input.context.runtime.processId,
      providerModule: input.providerModule,
      requestId: input.context.requestId,
      resource: challenge.resolved,
      selection: resolvedSelection,
      signal: input.context.signal,
      subrequestId: challengeId
    })
    input.registerTerminalOwner(providerAuthority.owns)
    const binding = providerAuthority.authority.invocationBinding
    const context = Object.freeze({
      ...input.context,
      authorityBindings: resolvedSelection.authorityBindings,
      capabilities: resolvedSelection.bindings,
      phase: 'resolved' as const,
      resource: Object.freeze({
        binding,
        requested: input.context.resource.requested,
        resolved: challenge.resolved
      })
    })
    const expiresAtMonotonicMs = evidence.kind === 'networkAddress'
      ? evidence.expiresAtMonotonicMs
      : Number.MAX_SAFE_INTEGER
    const token = normalizeResolutionAdmissionTokenV1({
      challengeId,
      evidenceDigest,
      expiresAtMonotonicMs,
      generation: input.context.runtime.generation,
      invocationBindingDigest: binding.invocationBindingDigest,
      parentRequestId: input.context.requestId,
      requestedSemanticDigest: challenge.requested.semanticResourceDigest,
      resolvedSemanticDigest: challenge.resolved.semanticResourceDigest,
      sequence,
      tokenId: `token-${identity.slice(0, 40)}`
    })
    evidenceStore.set(bindingId, Object.freeze({ digest: evidenceDigest, evidence }))
    let consumed = false
    return Object.freeze({
      authority: providerAuthority.authority,
      context,
      token,
      consume(value: CapabilityProviderResolutionVerificationV1): void {
        const current = normalizeProviderResolutionEvidenceV1(input, value.evidence)
        let resolved
        try {
          resolved = validateCanonicalResourceV1(value.resolved)
        } catch {
          return resolutionProtocolFailureV1(input)
        }
        const stored = evidenceStore.get(bindingId)
        if (
          consumed || input.context.signal.aborted || stored == null || now() > token.expiresAtMonotonicMs ||
          resolved.semanticResourceDigest !== token.resolvedSemanticDigest ||
          resolutionEvidenceDigestV1(current) !== stored.digest
        ) capabilityFailure('resource.invalid', input.context.operation, token.resolvedSemanticDigest)
        consumed = true
      },
      dispose(): void {
        evidenceStore.delete(bindingId)
      }
    }) satisfies AdmittedProviderResolutionV1<THostContext>
  }

  return Object.freeze({
    admitSync(request: CapabilityProviderResolutionRequestV1) {
      const admitted = prepare(request)
      runResolutionMiddlewareSyncV1(admitted.context, resolutionMiddleware(input, admitted.context))
      return admitted
    },
    async admit(request: CapabilityProviderResolutionRequestV1) {
      const admitted = prepare(request)
      await runResolutionMiddlewareAsyncV1(admitted.context, resolutionMiddleware(input, admitted.context))
      return admitted
    }
  }) satisfies CapabilityProviderResolutionAdmitterV1<THostContext>
}
