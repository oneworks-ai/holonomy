import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { copyJsonValue, freezeJsonValue } from './json-value.mjs'

const LIMIT_KEYS = Object.freeze([
  'maxChunkBytes',
  'maxConcurrentConnections',
  'maxHeaderBytes',
  'maxHeaders',
  'maxRequestBodyBytes',
  'maxResponseBodyBytes',
  'maxUrlBytes',
  'socketTimeoutMs'
])
const DEFAULT_LIMITS = Object.freeze({
  maxChunkBytes: 65_536,
  maxConcurrentConnections: 8,
  maxHeaderBytes: 65_536,
  maxHeaders: 128,
  maxRequestBodyBytes: 1_048_576,
  maxResponseBodyBytes: 8_388_608,
  maxUrlBytes: 65_536,
  socketTimeoutMs: 30_000
})
const DEFAULT_POLICY = Object.freeze({
  filesystem: Object.freeze({ access: 'none' }),
  network: Object.freeze({ access: 'none' }),
  schemaVersion: 1
})

const invalid = () => {
  throw new TypeError('Invalid Node Runtime sandbox policy')
}
const exact = (value, keys) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) invalid()
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) invalid()
  return value
}
const sortedUnique = values =>
  Array.isArray(values) && values.length > 0 &&
  values.every(value => typeof value === 'string') &&
  JSON.stringify(values) === JSON.stringify([...new Set(values)].sort())

const readLimits = value => {
  const limits = exact(value, LIMIT_KEYS)
  if (LIMIT_KEYS.some(key => !Number.isSafeInteger(limits[key]))) invalid()
  if (
    limits.maxChunkBytes < 1 || limits.maxChunkBytes > 1_048_576 ||
    limits.maxConcurrentConnections < 1 || limits.maxConcurrentConnections > 128 ||
    limits.maxHeaderBytes < 1 || limits.maxHeaderBytes > 1_048_576 ||
    limits.maxHeaders < 1 || limits.maxHeaders > 1_024 ||
    limits.maxRequestBodyBytes < limits.maxChunkBytes || limits.maxRequestBodyBytes > 67_108_864 ||
    limits.maxResponseBodyBytes < limits.maxChunkBytes || limits.maxResponseBodyBytes > 268_435_456 ||
    limits.maxConcurrentConnections * limits.maxRequestBodyBytes > 67_108_864 ||
    limits.maxUrlBytes < 1 || limits.maxUrlBytes > 1_048_576 ||
    limits.socketTimeoutMs < 1 || limits.socketTimeoutMs > 120_000
  ) invalid()
  return Object.freeze({ ...limits })
}

const readOrigin = value => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65_536) invalid()
  let url
  try {
    url = new URL(value)
  } catch {
    return invalid()
  }
  if (value !== url.origin || !['http:', 'https:'].includes(url.protocol)) invalid()
  return value
}

const readPolicy = input => {
  if (input === undefined) return DEFAULT_POLICY
  const policy = exact(input, ['filesystem', 'network', 'schemaVersion'])
  if (policy.schemaVersion !== 1) invalid()
  const filesystem = exact(policy.filesystem, ['access'])
  if (filesystem.access !== 'none') invalid()
  const access = policy.network?.access
  if (access === 'none') {
    exact(policy.network, ['access'])
    return DEFAULT_POLICY
  }
  if (!['mockOnly', 'restricted'].includes(access)) invalid()
  const network = exact(policy.network, [
    'access',
    'allowedOrigins',
    'allowedSchemes',
    'allowPrivateNetwork',
    'limits'
  ])
  if (
    !sortedUnique(network.allowedOrigins) || network.allowedOrigins.length > 64 ||
    !sortedUnique(network.allowedSchemes) || network.allowedSchemes.some(value => !['http', 'https'].includes(value)) ||
    typeof network.allowPrivateNetwork !== 'boolean'
  ) invalid()
  const origins = network.allowedOrigins.map(readOrigin)
  if (origins.some(origin => !network.allowedSchemes.includes(new URL(origin).protocol.slice(0, -1)))) invalid()
  return freezeJsonValue({
    filesystem: { access: 'none' },
    network: {
      access,
      allowedOrigins: origins,
      allowedSchemes: network.allowedSchemes,
      allowPrivateNetwork: network.allowPrivateNetwork,
      limits: readLimits(network.limits)
    },
    schemaVersion: 1
  })
}

export const nodeSandboxPolicyDigest = policy => {
  const network = policy.network
  const lines = [String(policy.schemaVersion), network.access]
  if (network.access === 'none') {
    lines.push('--schemes--', 'false', Object.values(DEFAULT_LIMITS).join(':'))
  } else {
    lines.push(...network.allowedOrigins, '--schemes--', ...network.allowedSchemes)
    lines.push(String(network.allowPrivateNetwork), LIMIT_KEYS.map(key => network.limits[key]).join(':'))
  }
  lines.push(policy.filesystem.access)
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

const readPlan = (input, policy, suppliedPolicy) => {
  if (input === undefined) {
    if (suppliedPolicy) invalid()
    return Object.freeze({
      access: 'none',
      capabilities: Object.freeze([]),
      policyDigest: nodeSandboxPolicyDigest(policy),
      principal: 'holonomy:direct:node:1'
    })
  }
  const enabled = policy.network.access !== 'none'
  const keys = enabled
    ? ['access', 'authority', 'capabilities', 'policyDigest', 'principal']
    : ['access', 'capabilities', 'policyDigest', 'principal']
  const plan = exact(input, keys)
  if (
    plan.access !== policy.network.access || plan.policyDigest !== nodeSandboxPolicyDigest(policy) ||
    typeof plan.principal !== 'string' || plan.principal.length > 512 || !plan.principal.startsWith('holonomy:')
  ) invalid()
  const expectedCapability = plan.access === 'mockOnly' ? 'host.network.mock' : 'host.network.http'
  if (
    !Array.isArray(plan.capabilities) ||
    JSON.stringify(plan.capabilities) !== JSON.stringify(enabled ? [expectedCapability] : [])
  ) {
    invalid()
  }
  if (!enabled) return freezeJsonValue(plan)
  const authority = exact(plan.authority, ['allowedOrigins', 'allowedSchemes', 'limits', 'privateNetwork'])
  if (
    JSON.stringify(authority.allowedOrigins) !== JSON.stringify(policy.network.allowedOrigins) ||
    JSON.stringify(authority.allowedSchemes) !== JSON.stringify(policy.network.allowedSchemes) ||
    JSON.stringify(authority.limits) !== JSON.stringify(policy.network.limits) ||
    authority.privateNetwork !== (policy.network.allowPrivateNetwork ? 'allow' : 'deny')
  ) invalid()
  return freezeJsonValue(plan)
}

export const normalizeNodeSandboxSession = (policyInput, planInput) => {
  const copiedPolicy = policyInput === undefined ? undefined : copyJsonValue(policyInput, 'sandbox policy')
  const copiedPlan = planInput === undefined ? undefined : copyJsonValue(planInput, 'sandbox plan')
  const policy = readPolicy(copiedPolicy)
  return Object.freeze({ plan: readPlan(copiedPlan, policy, copiedPolicy !== undefined), policy })
}
