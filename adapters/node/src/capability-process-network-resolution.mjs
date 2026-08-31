import dns from 'node:dns'
import { isIP } from 'node:net'
import process from 'node:process'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import {
  CapabilityInvocationError,
  authorizeResolvedAddress,
  normalizeResolutionEvidenceV1,
  resolutionEvidenceDigestV1
} from '../../../dist/capability-runtime/index.js'

const DNS_TTL_MS = 30_000
const DNS_ATTEMPTS = 3
const trace = value => {
  if (process.env.HOLO_V86_TRACE === '1') process.stderr.write(`[v86:dns] ${value}\n`)
}

const fail = (code, context) => {
  throw new CapabilityInvocationError(
    code,
    context.operation,
    context.resource.requested.semanticResourceDigest
  )
}

const addresses = async (resolve, hostname, context, policy) => {
  let values
  if (isIP(hostname) !== 0) values = [{ address: hostname }]
  else {
    for (let attempt = 0; attempt < DNS_ATTEMPTS; attempt += 1) {
      try {
        values = await resolve(hostname, { all: true, verbatim: true })
        break
      } catch (error) {
        trace(`${hostname} attempt=${attempt + 1} error=${String(error?.code ?? error)}`)
        if (attempt + 1 < DNS_ATTEMPTS) {
          await new Promise(resolveAttempt => setTimeout(resolveAttempt, 5))
        }
      }
    }
    if (values == null) return fail('provider.unavailable', context)
  }
  if (!Array.isArray(values) || values.length < 1 || values.length > 64) {
    return fail('provider.protocol_error', context)
  }
  let output
  try {
    output = [
      ...new Set(values.map(item => {
        if (typeof item?.address !== 'string' || isIP(item.address) === 0) {
          return fail('provider.protocol_error', context)
        }
        return authorizeResolvedAddress({
          privateNetwork: policy.network.privateNetwork === 'allow' ? 'allow' : 'deny'
        }, item.address)
      }))
    ].sort()
  } catch (error) {
    if (error?.code === 'network.invalid_url') return fail('policy.denied', context)
    throw error
  }
  if (output.length < 1) return fail('provider.unavailable', context)
  trace(`${hostname} addresses=${output.join(',')}`)
  return output
}

export const createNodeProcessNetworkResolutionV1 = async ({
  context,
  generation,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  policy,
  resolve = dns.promises.lookup
}) => {
  const resource = context.resource.requested
  const resolvedAddresses = await addresses(resolve, resource.hostname, context, policy)
  const evidence = normalizeResolutionEvidenceV1({
    addresses: resolvedAddresses,
    expiresAtMonotonicMs: now() + DNS_TTL_MS,
    kind: 'networkAddress',
    resolverGeneration: generation
  })
  return Object.freeze({
    evidence,
    receipt: Object.freeze({
      addresses: evidence.addresses,
      evidenceDigest: resolutionEvidenceDigestV1(evidence),
      expiresAtMonotonicMs: evidence.expiresAtMonotonicMs,
      resolverGeneration: evidence.resolverGeneration
    }),
    async verify() {
      if (now() > evidence.expiresAtMonotonicMs) return fail('resource.stale', context)
      const current = await addresses(resolve, resource.hostname, context, policy)
      if (
        current.length !== evidence.addresses.length ||
        current.some((address, index) => address !== evidence.addresses[index])
      ) {
        trace(`${resource.hostname} rebound=${current.join(',')} admitted=${evidence.addresses.join(',')}`)
        return fail('resource.invalid', context)
      }
      return Object.freeze({ evidence, resolved: resource })
    }
  })
}
