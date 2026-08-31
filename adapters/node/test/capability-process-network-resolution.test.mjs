import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { NodeProcessProviderV1 } from '../src/capability-process-provider.mjs'

const networkResource = Object.freeze({
  hostname: 'example.test',
  kind: 'processNetworkEndpoint',
  port: 443,
  semanticResourceDigest: '1'.repeat(64),
  transport: 'tls'
})
const policy = Object.freeze({
  access: 'sandboxed',
  environment: { allowedNames: [], maxValueBytes: 1024 },
  executables: [{ argumentBytes: 1024, executableId: 'curl' }],
  limits: {
    maxConcurrentProcesses: 1,
    maxExecutionTimeMs: 1000,
    maxOpenPipes: 3,
    maxProcessTreeDepth: 2,
    maxStderrBytes: 1024,
    maxStdinBytes: 1024,
    maxStdoutBytes: 1024,
    maxTotalProcesses: 2,
    maxWritableRootfsBytes: 0
  },
  mounts: [],
  network: {
    access: 'restricted',
    endpoints: [{ hostname: 'example.test', ports: [443], transport: 'tls' }],
    maxSockets: 1,
    privateNetwork: 'deny'
  },
  shell: { access: 'none' }
})
const profile = Object.freeze({
  backend: { backendId: 'test-v1', configuration: {} },
  environment: { allowedScopes: ['processTree'], defaultScope: 'processTree' },
  executables: [{
    executable: { kind: 'guestPath', path: '/usr/bin/curl' },
    executableId: 'curl',
    fixedArgs: [],
    shell: false
  }]
})
const context = Object.freeze({
  operation: 'process.network.connect',
  requestId: 'process-network-1',
  resource: { requested: networkResource },
  runtime: { generation: 7 }
})
const authority = () => ({
  bindings: [{
    capabilityName: 'host.process.network',
    constraints: policy.network,
    providerModule: 'host.process'
  }],
  complete(result) {
    return { result }
  },
  invocationBinding: { invocationBindingDigest: '2'.repeat(64) }
})
const backend = {
  closeGeneration() {},
  descriptor: { features: { shell: true, signals: true, synchronousSpawn: false } }
}

test('Process Provider publishes one sorted DNS evidence set and returns it in the authorization receipt', async () => {
  const resolutions = [
    [
      { address: '93.184.216.35', family: 4 },
      { address: '93.184.216.34', family: 4 }
    ],
    [
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 }
    ]
  ]
  const provider = new NodeProcessProviderV1(profile, policy, 7, { get: () => backend }, {
    networkResolution: {
      now: () => 100,
      resolve: async () => resolutions.shift()
    }
  })
  const plan = await provider.preflight(context, authority())
  assert.deepEqual(plan.requests[0].evidence.addresses, ['93.184.216.34', '93.184.216.35'])
  assert.equal(plan.requests[0].evidence.expiresAtMonotonicMs, 30_100)
  assert.deepEqual(await plan.requests[0].verify(), {
    evidence: plan.requests[0].evidence,
    resolved: networkResource
  })
  const providerAuthority = authority()
  const terminal = plan.execute(context, [providerAuthority])
  assert.deepEqual({ ...terminal.result.value.resolution }, {
    addresses: ['93.184.216.34', '93.184.216.35'],
    evidenceDigest: terminal.result.value.resolution.evidenceDigest,
    expiresAtMonotonicMs: 30_100,
    resolverGeneration: 7
  })
  assert.match(terminal.result.value.resolution.evidenceDigest, /^[\da-f]{64}$/u)
  await provider.close()
})

test('Process Provider rejects DNS rebinding and private resolution before transport execution', async () => {
  const resolutions = [
    [{ address: '93.184.216.34', family: 4 }],
    [{ address: '93.184.216.35', family: 4 }]
  ]
  const provider = new NodeProcessProviderV1(profile, policy, 7, { get: () => backend }, {
    networkResolution: { now: () => 100, resolve: async () => resolutions.shift() }
  })
  const plan = await provider.preflight(context, authority())
  await assert.rejects(plan.requests[0].verify(), { code: 'resource.invalid' })

  const privateProvider = new NodeProcessProviderV1(profile, policy, 7, { get: () => backend }, {
    networkResolution: {
      now: () => 100,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }]
    }
  })
  await assert.rejects(privateProvider.preflight(context, authority()), { code: 'policy.denied' })
  await provider.close()
  await privateProvider.close()
})

test('Process Provider retries transient DNS lookup failure without widening the admitted set', async () => {
  let calls = 0
  const provider = new NodeProcessProviderV1(profile, policy, 7, { get: () => backend }, {
    networkResolution: {
      resolve: async () => {
        calls += 1
        if (calls === 1) throw Object.assign(new Error('transient DNS failure'), { code: 'EAI_AGAIN' })
        return [{ address: '93.184.216.34', family: 4 }]
      }
    }
  })
  const plan = await provider.preflight(context, authority())
  assert.deepEqual(plan.requests[0].evidence.addresses, ['93.184.216.34'])
  await plan.requests[0].verify()
  assert.equal(calls, 3)
  await provider.close()
})
