import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import Ajv2020 from 'ajv/dist/2020.js'

import { serviceError } from './errors.mjs'
import { SANDBOX_POLICY_SCHEMA } from './sandbox-policy-schema.mjs'

export const SANDBOX_POLICY_MAX_BYTES = 1024 * 1024
export const DEFAULT_SANDBOX_POLICY = Object.freeze({
  filesystem: Object.freeze({ access: 'none' }),
  network: Object.freeze({ access: 'none' }),
  schemaVersion: 1
})

const validator = new Ajv2020({ allErrors: false, strict: true }).compile(SANDBOX_POLICY_SCHEMA)
const invalid = () => {
  throw serviceError('service.invalid_request', 'Sandbox policy is invalid')
}

const canonicalOrigin = value => {
  if (Buffer.byteLength(value) > 65_536) invalid()
  let url
  try {
    url = new URL(value)
  } catch {
    return invalid()
  }
  const scheme = url.protocol.slice(0, -1)
  if (
    value !== url.origin || !['http', 'https'].includes(scheme) || url.username !== '' ||
    url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== ''
  ) invalid()
  return Object.freeze({ origin: value, scheme })
}

const copyInput = value => {
  if (value === undefined) return DEFAULT_SANDBOX_POLICY
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    return invalid()
  }
  if (typeof serialized !== 'string') return invalid()
  if (Buffer.byteLength(serialized) > SANDBOX_POLICY_MAX_BYTES) {
    throw serviceError('service.limit_exceeded', 'Sandbox policy exceeds its limit')
  }
  const copied = JSON.parse(serialized)
  if (!validator(copied)) invalid()
  return copied
}

const validateLimits = limits => {
  if (
    limits.maxRequestBodyBytes < limits.maxChunkBytes ||
    limits.maxResponseBodyBytes < limits.maxChunkBytes ||
    limits.maxConcurrentConnections * limits.maxRequestBodyBytes > 64 * 1024 * 1024
  ) invalid()
  return Object.freeze({ ...limits })
}

export const sandboxPolicyDigest = policy => {
  const network = policy.network
  const canonical = [String(policy.schemaVersion), network.access]
  if (network.access !== 'none') {
    canonical.push(...network.allowedOrigins, '--schemes--', ...network.allowedSchemes)
    canonical.push(String(network.allowPrivateNetwork))
    const limits = network.limits
    canonical.push([
      limits.maxChunkBytes,
      limits.maxConcurrentConnections,
      limits.maxHeaderBytes,
      limits.maxHeaders,
      limits.maxRequestBodyBytes,
      limits.maxResponseBodyBytes,
      limits.maxUrlBytes,
      limits.socketTimeoutMs
    ].join(':'))
  } else canonical.push('--schemes--', 'false', '65536:8:65536:128:1048576:8388608:65536:30000')
  canonical.push(policy.filesystem.access)
  return createHash('sha256').update(canonical.join('\n')).digest('hex')
}

export const compileSandboxPolicy = value => {
  const copied = copyInput(value)
  if (copied === DEFAULT_SANDBOX_POLICY) {
    return Object.freeze({ digest: sandboxPolicyDigest(copied), policy: copied })
  }
  if (copied.filesystem.access === 'sandboxed') {
    throw serviceError('sandbox.capability_unsupported', 'Sandboxed filesystem access is unavailable')
  }
  let network = Object.freeze({ access: 'none' })
  if (copied.network.access !== 'none') {
    const origins = copied.network.allowedOrigins.map(canonicalOrigin)
    const originValues = origins.map(value => value.origin).sort()
    const schemes = [...copied.network.allowedSchemes].sort()
    if (origins.some(value => !schemes.includes(value.scheme))) invalid()
    network = Object.freeze({
      access: copied.network.access,
      allowedOrigins: Object.freeze(originValues),
      allowedSchemes: Object.freeze(schemes),
      allowPrivateNetwork: copied.network.allowPrivateNetwork,
      limits: validateLimits(copied.network.limits)
    })
  }
  const policy = Object.freeze({
    filesystem: Object.freeze({ access: copied.filesystem.access }),
    network,
    schemaVersion: 1
  })
  return Object.freeze({ digest: sandboxPolicyDigest(policy), policy })
}

export const compileEffectiveSandboxPolicy = (policy, fixtureUrl) => {
  const compiled = compileSandboxPolicy(policy)
  if (fixtureUrl == null) return compiled
  let fixture
  try {
    fixture = new URL(fixtureUrl)
  } catch {
    return invalid()
  }
  if (
    fixture.protocol !== 'http:' || fixture.username !== '' || fixture.password !== '' ||
    compiled.policy.network.access !== 'restricted' ||
    !compiled.policy.network.allowPrivateNetwork ||
    !compiled.policy.network.allowedSchemes.includes('http')
  ) invalid()
  const origin = canonicalOrigin(fixture.origin).origin
  const allowedOrigins = [...compiled.policy.network.allowedOrigins]
  if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin)
  if (allowedOrigins.length > 64) invalid()
  return compileSandboxPolicy({
    filesystem: compiled.policy.filesystem,
    network: { ...compiled.policy.network, allowedOrigins },
    schemaVersion: 1
  })
}

export const assertSandboxNetworkRuleSet = (policy, ruleSet) => {
  if (policy.network.access === 'none') {
    throw serviceError('sandbox.capability_unsupported', 'Sandbox network access is disabled')
  }
  if (
    policy.network.access === 'mockOnly' &&
    (ruleSet.mode !== 'failClosed' || ruleSet.rules.some(rule => rule.action.type === 'passthrough'))
  ) throw serviceError('service.invalid_request', 'Mock-only sandbox rules must remain fail closed')
  return ruleSet
}

export const sandboxDefaultNetworkRuleSet = policy =>
  Object.freeze({
    mode: policy.network.access === 'mockOnly' ? 'failClosed' : 'passthrough',
    rules: Object.freeze([])
  })

export const compileSandboxPlan = ({ generation, policy, processId, target }) => {
  const compiled = compileSandboxPolicy(policy)
  policy = compiled.policy
  const principal = `holonomy:${processId}:${target}:${generation}`
  const policyDigest = compiled.digest
  if (policy.network.access === 'none') {
    return Object.freeze({ access: 'none', capabilities: Object.freeze([]), policyDigest, principal })
  }
  return Object.freeze({
    access: policy.network.access,
    authority: Object.freeze({
      allowedOrigins: policy.network.allowedOrigins,
      allowedSchemes: policy.network.allowedSchemes,
      limits: policy.network.limits,
      privateNetwork: policy.network.allowPrivateNetwork ? 'allow' : 'deny'
    }),
    capabilities: Object.freeze([
      policy.network.access === 'mockOnly' ? 'host.network.mock' : 'host.network.http'
    ]),
    policyDigest,
    principal
  })
}
