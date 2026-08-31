export const policyVectors = api => {
  const defaultCompiled = api.compileSandboxPolicyV2({ schemaVersion: 2 })
  const restrictedCompiled = api.compileSandboxPolicyV2(api.restrictedPolicyInput)
  return {
    schemaVersion: 1,
    vectors: [
      {
        canonicalJson: defaultCompiled.canonicalJson,
        digest: defaultCompiled.digest,
        input: { schemaVersion: 2 },
        name: 'default-deny',
        normalized: api.defaultPolicy
      },
      {
        canonicalJson: restrictedCompiled.canonicalJson,
        digest: restrictedCompiled.digest,
        input: api.restrictedPolicyInput,
        name: 'restricted-network-filesystem',
        normalized: restrictedCompiled.policy
      }
    ]
  }
}

export const CAPABILITY_VECTOR_LIMITS = Object.freeze({
  filesystem: Object.freeze({
    maxDirectoryEntries: 100,
    maxOpenHandles: 10,
    maxQueuedEvents: 16,
    maxReadBytes: 1000,
    maxWatchers: 2,
    maxWriteBytes: 1000
  }),
  network: Object.freeze({
    maxChunkBytes: 1024,
    maxConcurrentConnections: 4,
    maxHeaderBytes: 4096,
    maxHeaders: 32,
    maxRedirects: 4,
    maxRequestBodyBytes: 4096,
    maxResponseBodyBytes: 8192,
    maxUrlBytes: 2048,
    socketTimeoutMs: 1000
  })
})
