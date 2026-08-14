import { validateCanonicalResourceV1 } from './canonical-resource-validation.js'
import { invalidPolicy } from './errors.js'
import type {
  ResolutionAdmissionTokenV1,
  ResolutionEvidenceV1,
  ResolvedResourceChallengeV1
} from './resolution-types.js'
import type { FilesystemResourceV1, NetworkResourceV1, OpaqueHandleResourceV1 } from './resource-types.js'
import { deepFreeze, exact, finiteNumber, identifier, integer, literal, required, string } from './validation.js'

const digest = (value: unknown): string => {
  const output = string(value, 64)
  if (!/^[\da-f]{64}$/u.test(output)) return invalidPolicy()
  return output
}
const resource = <T>(value: unknown, kind: string): T => {
  const output = validateCanonicalResourceV1(value)
  if (output.kind !== kind) return invalidPolicy()
  return output as T
}
const binding = <K extends ResolutionEvidenceV1['kind']>(value: unknown, kind: K) => {
  const input = exact(value, ['bindingId', 'evidenceDigest', 'kind'])
  if (required(input, 'kind') !== kind) return invalidPolicy()
  return Object.freeze({
    bindingId: identifier(required(input, 'bindingId'), 128),
    evidenceDigest: digest(required(input, 'evidenceDigest')),
    kind
  })
}

export const normalizeResolvedResourceChallengeV1 = (
  value: unknown
): ResolvedResourceChallengeV1 => {
  const input = exact(value, [
    'challengeId',
    'evidence',
    'parentRequestId',
    'reason',
    'requested',
    'resolved',
    'schemaVersion',
    'sequence'
  ])
  if (required(input, 'schemaVersion') !== 1) return invalidPolicy()
  const reason = literal(required(input, 'reason'), ['filesystemTarget', 'networkAddress', 'opaqueRebind'] as const)
  const base = {
    challengeId: identifier(required(input, 'challengeId'), 128),
    parentRequestId: identifier(required(input, 'parentRequestId'), 128),
    schemaVersion: 1 as const,
    sequence: integer(required(input, 'sequence'), 1, 32)
  }
  if (reason === 'networkAddress') {
    const requested = resource<NetworkResourceV1>(required(input, 'requested'), 'network')
    const resolved = resource<NetworkResourceV1>(required(input, 'resolved'), 'network')
    if (requested.semanticResourceDigest !== resolved.semanticResourceDigest) return invalidPolicy()
    return deepFreeze({
      ...base,
      evidence: binding(required(input, 'evidence'), 'networkAddress'),
      reason,
      requested,
      resolved
    })
  }
  if (reason === 'filesystemTarget') {
    const requested = resource<FilesystemResourceV1>(required(input, 'requested'), 'filesystem')
    const resolved = resource<FilesystemResourceV1>(required(input, 'resolved'), 'filesystem')
    if (requested.rootId !== resolved.rootId) return invalidPolicy()
    return deepFreeze({
      ...base,
      evidence: binding(required(input, 'evidence'), 'filesystemTarget'),
      reason,
      requested,
      resolved
    })
  }
  const requested = resource<OpaqueHandleResourceV1>(required(input, 'requested'), 'opaqueHandle')
  const resolved = resource<OpaqueHandleResourceV1>(required(input, 'resolved'), 'opaqueHandle')
  if (
    requested.semanticResourceDigest !== resolved.semanticResourceDigest ||
    requested.bridgeIdentityDigest !== resolved.bridgeIdentityDigest ||
    requested.generation !== resolved.generation || requested.resourceType !== resolved.resourceType ||
    requested.rightsDigest !== resolved.rightsDigest
  ) return invalidPolicy()
  return deepFreeze({
    ...base,
    evidence: binding(required(input, 'evidence'), 'opaqueIdentity'),
    reason,
    requested,
    resolved
  })
}

export const normalizeResolutionAdmissionTokenV1 = (value: unknown): ResolutionAdmissionTokenV1 => {
  const input = exact(value, [
    'challengeId',
    'evidenceDigest',
    'expiresAtMonotonicMs',
    'generation',
    'invocationBindingDigest',
    'parentRequestId',
    'requestedSemanticDigest',
    'resolvedSemanticDigest',
    'sequence',
    'tokenId'
  ])
  return Object.freeze({
    challengeId: identifier(required(input, 'challengeId'), 128),
    evidenceDigest: digest(required(input, 'evidenceDigest')),
    expiresAtMonotonicMs: finiteNumber(required(input, 'expiresAtMonotonicMs'), 0, Number.MAX_SAFE_INTEGER),
    generation: integer(required(input, 'generation'), 1, Number.MAX_SAFE_INTEGER),
    invocationBindingDigest: digest(required(input, 'invocationBindingDigest')),
    parentRequestId: identifier(required(input, 'parentRequestId'), 128),
    requestedSemanticDigest: digest(required(input, 'requestedSemanticDigest')),
    resolvedSemanticDigest: digest(required(input, 'resolvedSemanticDigest')),
    sequence: integer(required(input, 'sequence'), 1, 32),
    tokenId: identifier(required(input, 'tokenId'), 128)
  })
}
