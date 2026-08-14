import { canonicalDigest } from './canonical-json.js'
import { invalidPolicy } from './errors.js'
import type { ResolutionEvidenceV1 } from './resolution-types.js'
import { normalizeIpAddress } from './system-addresses.js'
import { array, deepFreeze, exact, finiteNumber, identifier, integer, literal, required, string } from './validation.js'

const digest = (value: unknown) => {
  const output = string(value, 64)
  if (!/^[\da-f]{64}$/u.test(output)) return invalidPolicy()
  return output
}

export const normalizeResolutionEvidenceV1 = (value: unknown): ResolutionEvidenceV1 => {
  const kind = literal(
    required(
      exact(value, [
        'addresses',
        'ancestorIdentityDigests',
        'bridgeIdentityDigest',
        'expiresAtMonotonicMs',
        'generation',
        'kind',
        'resolverGeneration',
        'rightsDigest',
        'rootId',
        'targetIdentityDigest',
        'targetType'
      ]),
      'kind'
    ),
    ['filesystemTarget', 'networkAddress', 'opaqueIdentity'] as const
  )
  if (kind === 'networkAddress') {
    const input = exact(value, ['addresses', 'expiresAtMonotonicMs', 'kind', 'resolverGeneration'])
    const addresses = array(required(input, 'addresses'), 1, 64).map(item => normalizeIpAddress(item))
    if (new Set(addresses).size !== addresses.length) return invalidPolicy()
    addresses.sort()
    return deepFreeze({
      addresses,
      expiresAtMonotonicMs: finiteNumber(required(input, 'expiresAtMonotonicMs'), 0, Number.MAX_SAFE_INTEGER),
      kind,
      resolverGeneration: integer(required(input, 'resolverGeneration'), 0, Number.MAX_SAFE_INTEGER)
    })
  }
  if (kind === 'filesystemTarget') {
    const input = exact(value, [
      'ancestorIdentityDigests',
      'kind',
      'rootId',
      'targetIdentityDigest',
      'targetType'
    ])
    return deepFreeze({
      ancestorIdentityDigests: array(required(input, 'ancestorIdentityDigests'), 0, 256).map(digest),
      kind,
      rootId: identifier(required(input, 'rootId'), 64),
      targetIdentityDigest: digest(required(input, 'targetIdentityDigest')),
      targetType: literal(required(input, 'targetType'), ['directory', 'file', 'missing', 'symlink'] as const)
    })
  }
  const input = exact(value, ['bridgeIdentityDigest', 'generation', 'kind', 'rightsDigest'])
  return Object.freeze({
    bridgeIdentityDigest: digest(required(input, 'bridgeIdentityDigest')),
    generation: integer(required(input, 'generation'), 1, Number.MAX_SAFE_INTEGER),
    kind,
    rightsDigest: digest(required(input, 'rightsDigest'))
  })
}

export const resolutionEvidenceDigestV1 = (value: unknown): string =>
  canonicalDigest([
    'resolutionEvidence',
    normalizeResolutionEvidenceV1(value) as unknown as Record<string, never>
  ])
