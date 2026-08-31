import { describe, expect, it } from 'vitest'

import {
  CapabilityContractError,
  canonicalDigest,
  canonicalizeFilesystemResource,
  canonicalizeNetworkResource,
  canonicalizeOpaqueHandleResource,
  canonicalizeProcessNetworkEndpointResource,
  normalizeResolutionAdmissionTokenV1,
  normalizeResolutionEvidenceV1,
  normalizeResolvedResourceChallengeV1,
  resolutionEvidenceDigestV1
} from '../../../src/capability-runtime/index.js'

const hash = (value: string) => canonicalDigest(['resolution-test', value])
const evidenceBinding = (kind: 'filesystemTarget' | 'networkAddress' | 'opaqueIdentity') => ({
  bindingId: `evidence-${kind}`,
  evidenceDigest: hash(kind),
  kind
})

describe('resolved resource challenge v1', () => {
  it('normalizes typed network evidence without leaking resolver objects', () => {
    const input = {
      addresses: ['2001:db8::1', '192.0.2.1'],
      expiresAtMonotonicMs: 5000,
      kind: 'networkAddress',
      resolverGeneration: 2
    }
    const evidence = normalizeResolutionEvidenceV1(input)
    expect(evidence).toEqual({ ...input, addresses: ['192.0.2.1', '2001:db8::1'] })
    expect(resolutionEvidenceDigestV1(input)).toMatch(/^[\da-f]{64}$/u)
  })

  it('accepts a same-semantic network resolution challenge', () => {
    const requested = canonicalizeNetworkResource('https://api.example/profile', 'GET', null, 'Profile')
    const challenge = normalizeResolvedResourceChallengeV1({
      challengeId: 'challenge-1',
      evidence: evidenceBinding('networkAddress'),
      parentRequestId: 'request-1',
      reason: 'networkAddress',
      requested,
      resolved: { ...requested, display: { label: 'resolved' } },
      schemaVersion: 1,
      sequence: 1
    })
    expect(challenge.reason).toBe('networkAddress')
    expect(challenge.requested.semanticResourceDigest).toBe(challenge.resolved.semanticResourceDigest)
  })

  it('uses the same network resolution challenge for Process socket endpoints', () => {
    const requested = canonicalizeProcessNetworkEndpointResource({
      hostname: 'api.example',
      label: 'api.example:443',
      port: 443,
      transport: 'tls'
    })
    const challenge = normalizeResolvedResourceChallengeV1({
      challengeId: 'challenge-process-network',
      evidence: evidenceBinding('networkAddress'),
      parentRequestId: 'request-process-network',
      reason: 'networkAddress',
      requested,
      resolved: { ...requested, display: { label: 'resolved process endpoint' } },
      schemaVersion: 1,
      sequence: 1
    })
    expect(challenge.requested.kind).toBe('processNetworkEndpoint')
    expect(() =>
      normalizeResolvedResourceChallengeV1({
        challengeId: 'challenge-cross-network-kind',
        evidence: evidenceBinding('networkAddress'),
        parentRequestId: 'request-process-network',
        reason: 'networkAddress',
        requested,
        resolved: canonicalizeNetworkResource('https://api.example/', 'GET', null, 'fetch endpoint'),
        schemaVersion: 1,
        sequence: 1
      })
    ).toThrow(CapabilityContractError)
  })

  it('allows same-root filesystem semantic resolution and rejects cross-root targets', () => {
    const requested = canonicalizeFilesystemResource('holo-fs://workspace/link', 'link')
    const resolved = canonicalizeFilesystemResource('holo-fs://workspace/target', 'target')
    expect(
      normalizeResolvedResourceChallengeV1({
        challengeId: 'challenge-2',
        evidence: evidenceBinding('filesystemTarget'),
        parentRequestId: 'request-2',
        reason: 'filesystemTarget',
        requested,
        resolved,
        schemaVersion: 1,
        sequence: 1
      }).resolved.semanticResourceDigest
    ).not.toBe(requested.semanticResourceDigest)

    expect(() =>
      normalizeResolvedResourceChallengeV1({
        challengeId: 'challenge-2',
        evidence: evidenceBinding('filesystemTarget'),
        parentRequestId: 'request-2',
        reason: 'filesystemTarget',
        requested,
        resolved: canonicalizeFilesystemResource('holo-fs://other/target', 'target'),
        schemaVersion: 1,
        sequence: 1
      })
    ).toThrow(CapabilityContractError)
  })

  it('requires opaque rebind to preserve exact generation, rights and bridge identity', () => {
    const requested = canonicalizeOpaqueHandleResource({
      bridgeIdentityDigest: hash('bridge'),
      generation: 4,
      label: 'handle',
      resourceType: 'fs.file',
      rightsDigest: hash('rights')
    })
    expect(() =>
      normalizeResolvedResourceChallengeV1({
        challengeId: 'challenge-3',
        evidence: evidenceBinding('opaqueIdentity'),
        parentRequestId: 'request-3',
        reason: 'opaqueRebind',
        requested,
        resolved: { ...requested, generation: 5 },
        schemaVersion: 1,
        sequence: 1
      })
    ).toThrow(CapabilityContractError)
  })

  it('rejects cross-kind evidence, noncanonical addresses and tampered network semantics', () => {
    const requested = canonicalizeNetworkResource('https://api.example/profile', 'GET', null, 'Profile')
    expect(() =>
      normalizeResolvedResourceChallengeV1({
        challengeId: 'challenge-1',
        evidence: evidenceBinding('filesystemTarget'),
        parentRequestId: 'request-1',
        reason: 'networkAddress',
        requested,
        resolved: requested,
        schemaVersion: 1,
        sequence: 1
      })
    ).toThrow(CapabilityContractError)
    expect(() =>
      normalizeResolutionEvidenceV1({
        addresses: ['192.168.001.1'],
        expiresAtMonotonicMs: 5,
        kind: 'networkAddress',
        resolverGeneration: 1
      })
    ).toThrow(CapabilityContractError)
    expect(() =>
      normalizeResolvedResourceChallengeV1({
        challengeId: 'challenge-1',
        evidence: evidenceBinding('networkAddress'),
        parentRequestId: 'request-1',
        reason: 'networkAddress',
        requested,
        resolved: canonicalizeNetworkResource('https://api.example/admin', 'GET', null, 'Admin'),
        schemaVersion: 1,
        sequence: 1
      })
    ).toThrow(CapabilityContractError)

    const admin = canonicalizeNetworkResource('https://api.example/admin', 'GET', null, 'Admin')
    expect(() =>
      normalizeResolvedResourceChallengeV1({
        challengeId: 'challenge-forged-network',
        evidence: evidenceBinding('networkAddress'),
        parentRequestId: 'request-1',
        reason: 'networkAddress',
        requested,
        resolved: {
          ...admin,
          semanticId: requested.semanticId,
          semanticResourceDigest: requested.semanticResourceDigest
        },
        schemaVersion: 1,
        sequence: 1
      })
    ).toThrow(CapabilityContractError)
  })

  it('rejects forged filesystem root and semantic identity fields', () => {
    const requested = canonicalizeFilesystemResource('holo-fs://workspace/link', 'link')
    const other = canonicalizeFilesystemResource('holo-fs://other/secret', 'secret')
    expect(() =>
      normalizeResolvedResourceChallengeV1({
        challengeId: 'challenge-forged-filesystem',
        evidence: evidenceBinding('filesystemTarget'),
        parentRequestId: 'request-fs',
        reason: 'filesystemTarget',
        requested,
        resolved: {
          ...other,
          rootId: requested.rootId,
          semanticId: requested.semanticId,
          semanticResourceDigest: requested.semanticResourceDigest
        },
        schemaVersion: 1,
        sequence: 1
      })
    ).toThrow(CapabilityContractError)
  })

  it('normalizes bounded provider-only admission tokens', () => {
    expect(normalizeResolutionAdmissionTokenV1({
      challengeId: 'challenge-1',
      evidenceDigest: hash('evidence'),
      expiresAtMonotonicMs: 999,
      generation: 2,
      invocationBindingDigest: hash('invocation'),
      parentRequestId: 'request-1',
      requestedSemanticDigest: hash('requested'),
      resolvedSemanticDigest: hash('resolved'),
      sequence: 1,
      tokenId: 'token-1'
    })).toEqual(expect.objectContaining({ generation: 2, sequence: 1, tokenId: 'token-1' }))
  })
})
