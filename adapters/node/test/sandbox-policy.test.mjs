import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// eslint-disable-next-line test/no-import-node-test -- This adapter is verified with Node's public test runner.
import test from 'node:test'

import { createNodeNetworkPort } from '../src/node-network-transport.mjs'
import { nodeSandboxPolicyDigest } from '../src/sandbox-session.mjs'
import { normalizeNodeRuntimeSession } from '../src/session-validation.mjs'
import { sandboxLimits, sandboxSession } from './sandbox-fixture.mjs'

const base = source => ({
  entryUrl: 'app://sandbox/main.mjs',
  runtimeModules: [],
  syntheticModules: {},
  userModules: [{ source, url: 'app://sandbox/main.mjs' }]
})

const sharedVectors = JSON.parse(readFileSync(
  new URL('../../android/session-host/src/test/resources/sandbox-origin-vectors.json', import.meta.url),
  'utf8'
))

const sessionWithPolicy = policy => ({
  ...base('export {}'),
  sandboxPlan: policy.network.access === 'none'
    ? {
      access: 'none',
      capabilities: [],
      policyDigest: nodeSandboxPolicyDigest(policy),
      principal: 'holonomy:node-vector:node:1'
    }
    : {
      access: policy.network.access,
      authority: {
        allowedOrigins: policy.network.allowedOrigins,
        allowedSchemes: policy.network.allowedSchemes,
        limits: policy.network.limits,
        privateNetwork: policy.network.allowPrivateNetwork ? 'allow' : 'deny'
      },
      capabilities: ['host.network.http'],
      policyDigest: nodeSandboxPolicyDigest(policy),
      principal: 'holonomy:node-vector:node:1'
    },
  sandboxPolicy: policy
})

test('defaults to deny and rejects a caller-supplied compiled authority', () => {
  const denied = normalizeNodeRuntimeSession(base('export {}'))
  assert.equal(denied.sandboxPolicy.network.access, 'none')
  assert.equal(denied.sandboxPlan.access, 'none')
  assert.throws(
    () => normalizeNodeRuntimeSession({ ...base('export {}'), networkAuthority: { allowedOrigins: ['*'] } }),
    /Invalid Node Runtime session/u
  )
})

test('does not construct a native transport for mock-only access', () => {
  const session = normalizeNodeRuntimeSession({
    ...base('export {}'),
    ...sandboxSession({ access: 'mockOnly' }),
    networkRules: { mode: 'failClosed', rules: [] }
  })
  let hostConstructions = 0
  let portConstructions = 0
  const port = createNodeNetworkPort(session.sandboxPlan, () => undefined, {
    createHost: () => {
      hostConstructions += 1
      return {}
    },
    createPort: () => {
      portConstructions += 1
      return {}
    }
  })
  assert.equal(port, undefined)
  assert.equal(hostConstructions, 0)
  assert.equal(portConstructions, 0)
})

test('requires the Service plan to match the immutable policy digest and authority', () => {
  const sandbox = sandboxSession({ origin: 'https://api.example' })
  assert.doesNotThrow(() => normalizeNodeRuntimeSession({ ...base('export {}'), ...sandbox }))
  assert.throws(
    () =>
      normalizeNodeRuntimeSession({
        ...base('export {}'),
        ...sandbox,
        sandboxPlan: { ...sandbox.sandboxPlan, principal: 'guest' }
      }),
    /sandbox policy/u
  )
  assert.throws(
    () =>
      normalizeNodeRuntimeSession({
        ...base('export {}'),
        ...sandbox,
        sandboxPlan: {
          ...sandbox.sandboxPlan,
          authority: { ...sandbox.sandboxPlan.authority, allowedOrigins: ['https://other.example'] }
        }
      }),
    /sandbox policy/u
  )
})

test('shares every Android canonical origin and digest vector without copying it', () => {
  for (const vector of sharedVectors.origins) {
    const policy = {
      filesystem: { access: 'none' },
      network: {
        access: 'restricted',
        allowedOrigins: [vector.input],
        allowedSchemes: ['http', 'https'],
        allowPrivateNetwork: false,
        limits: sandboxLimits
      },
      schemaVersion: 1
    }
    if (vector.accepted) assert.doesNotThrow(() => normalizeNodeRuntimeSession(sessionWithPolicy(policy)))
    else assert.throws(() => normalizeNodeRuntimeSession(sessionWithPolicy(policy)), /sandbox policy/u)
  }
  for (const vector of sharedVectors.digests) {
    const policy = vector.access === 'none'
      ? { filesystem: { access: 'none' }, network: { access: 'none' }, schemaVersion: 1 }
      : {
        filesystem: { access: vector.filesystemAccess },
        network: {
          access: vector.access,
          allowedOrigins: vector.allowedOrigins,
          allowedSchemes: vector.allowedSchemes,
          allowPrivateNetwork: vector.allowPrivateNetwork,
          limits: sandboxLimits
        },
        schemaVersion: 1
      }
    assert.equal(nodeSandboxPolicyDigest(policy), vector.digest, vector.name)
    assert.doesNotThrow(() => normalizeNodeRuntimeSession(sessionWithPolicy(policy)))
  }
})
