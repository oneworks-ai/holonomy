import { nodeSandboxPolicyDigest } from '../src/sandbox-session.mjs'

export const sandboxLimits = Object.freeze({
  maxChunkBytes: 65_536,
  maxConcurrentConnections: 8,
  maxHeaderBytes: 65_536,
  maxHeaders: 128,
  maxRequestBodyBytes: 1_048_576,
  maxResponseBodyBytes: 8_388_608,
  maxUrlBytes: 65_536,
  socketTimeoutMs: 30_000
})

export const sandboxSession = (
  {
    access = 'restricted',
    limits = sandboxLimits,
    origin = 'http://mock.invalid',
    privateNetwork = false
  } = {}
) => {
  const policy = Object.freeze({
    filesystem: Object.freeze({ access: 'none' }),
    network: Object.freeze({
      access,
      allowedOrigins: Object.freeze([origin]),
      allowedSchemes: Object.freeze([new URL(origin).protocol.slice(0, -1)]),
      allowPrivateNetwork: privateNetwork,
      limits
    }),
    schemaVersion: 1
  })
  return Object.freeze({
    sandboxPlan: Object.freeze({
      access,
      authority: Object.freeze({
        allowedOrigins: policy.network.allowedOrigins,
        allowedSchemes: policy.network.allowedSchemes,
        limits,
        privateNetwork: privateNetwork ? 'allow' : 'deny'
      }),
      capabilities: Object.freeze([access === 'mockOnly' ? 'host.network.mock' : 'host.network.http']),
      policyDigest: nodeSandboxPolicyDigest(policy),
      principal: 'holonomy:node-test:node:1'
    }),
    sandboxPolicy: policy
  })
}
