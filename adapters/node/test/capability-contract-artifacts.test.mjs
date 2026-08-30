import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

// Adapter integration intentionally consumes the public build output installed in packages.
// eslint-disable-next-line antfu/no-import-dist
import {
  admitRuntimeCreationV1,
  canonicalDigest,
  canonicalJson,
  compileDeviceProviderDescriptorV1,
  compileHostSystemProjectionV1,
  compileSandboxPolicyV2,
  networkHeaderViewDigestV1,
  networkQueryViewDigestV1,
  normalizeEngineGateDecisionV1,
  normalizeEngineGateRequestMetadataV1,
  normalizeInvocationSnapshotEnvelopeV1,
  normalizeNetworkInvocationSnapshotV1,
  normalizeNetworkRedirectInvocationV1,
  normalizeResolvedResourceChallengeV1,
  normalizeRuntimeObserverEventV1
} from '../../../dist/capability-runtime/index.js'

const artifact = name =>
  JSON.parse(readFileSync(
    new URL(`../../../packages/runtime/src/kernel/machine/${name}`, import.meta.url),
    'utf8'
  ))

test('Node and Desktop consume the shared Policy, System and Device vectors', () => {
  for (const vector of artifact('sandbox-policy-v2.vectors.json').vectors) {
    const compiled = compileSandboxPolicyV2(vector.input)
    assert.equal(compiled.canonicalJson, vector.canonicalJson)
    assert.equal(compiled.digest, vector.digest)
    assert.deepEqual(compiled.policy, vector.normalized)
  }
  for (const vector of artifact('host-system-projection-v1.vectors.json').vectors) {
    assert.equal(
      canonicalJson(compileHostSystemProjectionV1(vector.input)),
      canonicalJson(vector.normalized)
    )
  }
  const devices = artifact('device-contract-v1.vectors.json').vectors
  for (const key of ['androidProvider', 'desktopProvider', 'nodeProvider']) {
    assert.equal(
      canonicalJson(compileDeviceProviderDescriptorV1(devices[key])),
      canonicalJson(devices[key])
    )
  }
})

test('Node and Desktop consume shared Snapshot, Engine Gate and Observer vectors', () => {
  const snapshots = artifact('invocation-snapshot-v1.vectors.json').vectors
  for (const vector of snapshots) {
    assert.equal(
      canonicalJson(normalizeInvocationSnapshotEnvelopeV1(vector.snapshot)),
      canonicalJson(vector.snapshot)
    )
  }
  const gate = artifact('engine-gate-v1.vectors.json')
  for (const request of gate.requests) {
    assert.equal(canonicalJson(normalizeEngineGateRequestMetadataV1(request)), canonicalJson(request))
  }
  for (const decision of gate.decisions) {
    assert.equal(canonicalJson(normalizeEngineGateDecisionV1(decision)), canonicalJson(decision))
  }
  const observer = artifact('observer-contract-v1.vectors.json')
  for (const event of observer.events) {
    assert.equal(canonicalJson(normalizeRuntimeObserverEventV1(event)), canonicalJson(event))
  }
})

test('Node and Desktop recompute shared resource and error contract identities', () => {
  const resources = artifact('canonical-resource-v1.vectors.json').vectors
  assert.equal(
    resources.filesystem.semanticResourceDigest,
    canonicalDigest([
      'filesystem',
      resources.filesystem.rootId,
      resources.filesystem.pathSegments
    ])
  )
  assert.notEqual(resources.program.semanticResourceDigest, resources.shell.semanticResourceDigest)
  assert.equal(
    resources.systemField.semanticResourceDigest,
    canonicalDigest(['systemField', resources.systemField.field])
  )
  const errors = artifact('capability-error-map-v1.json')
  assert.equal(errors['policy.denied'].nodeFs, 'EACCES')
  assert.equal(errors['middleware.permission_denied'].holo, 'holo.permission_denied')
  assert.equal(
    errors['resource.byte_limit'].childProcess.capturedOutput,
    'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  )
  assert.match(createHash('sha256').update(JSON.stringify(errors)).digest('hex'), /^[\da-f]{64}$/u)
})

test('Node and Desktop recompute Resolution and Runtime creation semantics', () => {
  const resolution = artifact('resource-resolution-v1.vectors.json')
  for (const value of resolution.valid) {
    assert.equal(
      canonicalJson(normalizeResolvedResourceChallengeV1(value)),
      canonicalJson(value)
    )
  }
  for (const vector of resolution.invalid) {
    assert.throws(
      () => normalizeResolvedResourceChallengeV1(vector.value),
      error => error?.code === vector.expectedCode,
      vector.name
    )
  }

  const creation = artifact('runtime-creation-v1.vectors.json')
  const resolveBinding = reference => ({ id: reference.bindingId })
  const admitted = creation.valid.map(vector =>
    admitRuntimeCreationV1(vector.spec, {
      expectedOwnerId: 'host-owner',
      generation: vector.generation,
      processId: 'process-vector',
      resolveBinding
    })
  )
  assert.equal(admitted[0].configurationDigest, admitted[1].configurationDigest)
  assert.notEqual(admitted[0].principal, admitted[1].principal)
  for (const vector of creation.invalid) {
    assert.throws(
      () =>
        admitRuntimeCreationV1(vector.spec, {
          expectedOwnerId: 'host-owner',
          generation: 1,
          processId: 'process-vector',
          resolveBinding
        }),
      error => error?.code === vector.code,
      vector.name
    )
  }
})

test('Node and Desktop recompute Network view digests and reject semantic forgeries', () => {
  const network = artifact('operation-contract-v1.vectors.json').network
  const request = network.valid.find(vector => vector.name === 'request-metadata').normalized
  assert.equal(request.headerDigest, networkHeaderViewDigestV1(request.headers))
  assert.equal(request.queryDigest, networkQueryViewDigestV1(request.query))
  assert.deepEqual(normalizeNetworkInvocationSnapshotV1(request), request)
  const redirect = network.valid.find(vector => vector.name === 'redirect-full-binding').normalized
  assert.deepEqual(normalizeNetworkRedirectInvocationV1(redirect), redirect)
  for (const vector of network.invalid.filter(item => item.semantic === true)) {
    const normalize = vector.schemaId === 'NetworkInvocationSnapshotV1'
      ? normalizeNetworkInvocationSnapshotV1
      : normalizeNetworkRedirectInvocationV1
    assert.throws(
      () => normalize(vector.value),
      error => error?.code === vector.expectedCode,
      vector.name
    )
  }
})
