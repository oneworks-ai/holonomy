import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'

import {
  DEFAULT_SANDBOX_POLICY,
  assertSandboxNetworkRuleSet,
  compileEffectiveSandboxPolicy,
  compileSandboxPlan,
  compileSandboxPolicy
} from '../sandbox-policy.mjs'

const limits = () => ({
  maxChunkBytes: 65_536,
  maxConcurrentConnections: 8,
  maxHeaderBytes: 65_536,
  maxHeaders: 128,
  maxRequestBodyBytes: 1_048_576,
  maxResponseBodyBytes: 8_388_608,
  maxUrlBytes: 65_536,
  socketTimeoutMs: 30_000
})

const sharedVectors = JSON.parse(readFileSync(
  new URL('../../../adapters/android/session-host/src/test/resources/sandbox-origin-vectors.json', import.meta.url),
  'utf8'
))

const restricted = (overrides = {}) => ({
  filesystem: { access: 'none' },
  network: {
    access: 'restricted',
    allowedOrigins: ['https://api.example', 'http://127.0.0.1:8123'],
    allowedSchemes: ['https', 'http'],
    allowPrivateNetwork: true,
    limits: limits(),
    ...overrides
  },
  schemaVersion: 1
})

describe('sandboxPolicy v1 compiler', () => {
  it('defaults to deny and matches the Android canonical digest vector', () => {
    const denied = compileSandboxPolicy(undefined)
    assert.deepEqual(denied.policy, DEFAULT_SANDBOX_POLICY)
    const compiled = compileSandboxPolicy(restricted())
    assert.deepEqual(compiled.policy.network.allowedOrigins, [
      'http://127.0.0.1:8123',
      'https://api.example'
    ])
    assert.deepEqual(compiled.policy.network.allowedSchemes, ['http', 'https'])
    assert.equal(compiled.digest, 'c21b2757f384761946c9cf571baf19642f99789d44bb74f70be3f0f5ef07c093')
  })

  it('shares every Android canonical origin and digest vector without copying it', () => {
    for (const vector of sharedVectors.origins) {
      const compile = () =>
        compileSandboxPolicy({
          filesystem: { access: 'none' },
          network: {
            access: 'restricted',
            allowedOrigins: [vector.input],
            allowedSchemes: ['http', 'https'],
            allowPrivateNetwork: false,
            limits: limits()
          },
          schemaVersion: 1
        })
      if (vector.accepted) assert.equal(compile().policy.network.allowedOrigins[0], vector.canonical)
      else assert.throws(compile, error => error.code === 'service.invalid_request')
    }
    for (const vector of sharedVectors.digests) {
      const compiled = vector.access === 'none'
        ? compileSandboxPolicy(undefined)
        : compileSandboxPolicy({
          filesystem: { access: vector.filesystemAccess },
          network: {
            access: vector.access,
            allowedOrigins: vector.allowedOrigins,
            allowedSchemes: vector.allowedSchemes,
            allowPrivateNetwork: vector.allowPrivateNetwork,
            limits: limits()
          },
          schemaVersion: 1
        })
      assert.equal(compiled.digest, vector.digest, vector.name)
    }
  })

  it('rejects unknown fields, non-canonical origins, invalid aggregate limits and filesystem elevation', () => {
    assert.throws(
      () => compileSandboxPolicy({ ...restricted(), principal: 'guest' }),
      error => error.code === 'service.invalid_request'
    )
    assert.throws(
      () => compileSandboxPolicy(restricted({ allowedOrigins: ['HTTPS://API.EXAMPLE'] })),
      error => error.code === 'service.invalid_request'
    )
    assert.throws(
      () =>
        compileSandboxPolicy(restricted({
          limits: { ...limits(), maxConcurrentConnections: 128, maxRequestBodyBytes: 64 * 1024 * 1024 }
        })),
      error => error.code === 'service.invalid_request'
    )
    assert.throws(
      () => compileSandboxPolicy({ ...restricted(), filesystem: { access: 'sandboxed' } }),
      error => error.code === 'sandbox.capability_unsupported' && error.status === 501
    )
  })

  it('adds only the exact trusted fixture origin without escalating private access', () => {
    const policy = compileSandboxPolicy(restricted()).policy
    const effective = compileEffectiveSandboxPolicy(policy, 'http://127.0.0.1:49123/profile')
    const plan = compileSandboxPlan({
      generation: 3,
      policy: effective.policy,
      processId: 'process_1',
      target: 'node'
    })
    assert.deepEqual(plan.authority.allowedOrigins, [
      'http://127.0.0.1:49123',
      'http://127.0.0.1:8123',
      'https://api.example'
    ])
    assert.equal(plan.authority.privateNetwork, 'allow')
    const deniedPrivate = compileSandboxPolicy(restricted({ allowPrivateNetwork: false })).policy
    assert.throws(
      () => compileEffectiveSandboxPolicy(deniedPrivate, 'http://127.0.0.1:49123'),
      error => error.code === 'service.invalid_request'
    )
  })

  it('keeps mock-only rules fail closed and rejects passthrough before adapter admission', () => {
    const policy = compileSandboxPolicy({
      ...restricted(),
      network: {
        ...restricted().network,
        access: 'mockOnly'
      }
    }).policy
    assert.doesNotThrow(() => assertSandboxNetworkRuleSet(policy, { mode: 'failClosed', rules: [] }))
    assert.throws(
      () => assertSandboxNetworkRuleSet(policy, { mode: 'passthrough', rules: [] }),
      error => error.code === 'service.invalid_request'
    )
    assert.throws(
      () =>
        assertSandboxNetworkRuleSet(policy, {
          mode: 'failClosed',
          rules: [{ action: { type: 'passthrough' } }]
        }),
      error => error.code === 'service.invalid_request'
    )
  })
})
