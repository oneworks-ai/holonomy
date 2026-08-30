import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { V86_PROCESS_BACKEND_DESCRIPTOR_V1, createV86ProcessBackendV1 } from '../src/capability-process-v86-backend.mjs'
import { V86FuseBridgeV1 } from '../src/capability-process-v86-fuse.mjs'

const digest = value => value.repeat(64)
const artifact = artifactId => ({ artifactId, sha256: digest('a') })
const configuration = {
  artifacts: {
    bios: artifact('v86-bios'),
    initialState: artifact('v86-warm-state'),
    initrd: artifact('holo-supervisor-initrd'),
    kernel: artifact('holo-linux'),
    wasm: artifact('v86-wasm')
  },
  memoryBytes: 64 * 1024 * 1024,
  requiredKernelCapabilities: ['process'],
  supervisor: { protocolVersion: 1 }
}

const environmentFactory = {
  async open() {
    return {
      async close() {},
      async spawn() {
        return {
          async closeStdin() {},
          async signal() {},
          async writeStdin() {}
        }
      }
    }
  }
}

test('publishes v86 as an injected experimental Linux Backend', () => {
  const backend = createV86ProcessBackendV1({ environmentFactory })
  assert.deepEqual(backend.descriptor, V86_PROCESS_BACKEND_DESCRIPTOR_V1)
  assert.equal(backend.descriptor.features.filesystemBridge, false)
  assert.equal(backend.descriptor.features.networkBridge, false)
  assert.deepEqual(backend.descriptor.environmentScopes, ['processTree', 'runtime'])
})

test('declares the filesystem Bridge only when the Host installs its handler', () => {
  const backend = createV86ProcessBackendV1({
    V86: class {},
    handleFilesystemRequest: async () => new Uint8Array(),
    loadArtifact: async () => new Uint8Array()
  })
  assert.equal(backend.descriptor.features.filesystemBridge, true)
  assert.equal(V86_PROCESS_BACKEND_DESCRIPTOR_V1.features.filesystemBridge, false)
  const launch = {
    configuration: backend.normalizeConfiguration(configuration),
    environmentScope: 'processTree',
    executable: backend.normalizeExecutable({ kind: 'guestPath', path: '/bin/cat' }),
    executableId: 'cat',
    generation: 1,
    operation: 'process.program.spawn',
    runtimeArgs: []
  }
  assert.doesNotThrow(() =>
    backend.prepareLaunch({
      ...launch,
      policy: {
        access: 'sandboxed',
        mounts: [{ guestPath: '/workspace', rights: ['read'], rootId: 'workspace' }]
      }
    })
  )
  for (const guestPath of ['/bin', '/sbin', '/usr', '/usr/bin', '/usr/sbin', '/workspace/nested']) {
    assert.throws(() =>
      backend.prepareLaunch({
        ...launch,
        policy: {
          access: 'sandboxed',
          mounts: [{ guestPath, rights: ['read'], rootId: 'workspace' }]
        }
      }), TypeError)
  }
})

test('rejects mounts when the v86 filesystem Bridge is not installed', () => {
  const backend = createV86ProcessBackendV1({ environmentFactory })
  assert.throws(() =>
    backend.prepareLaunch({
      configuration: backend.normalizeConfiguration(configuration),
      environmentScope: 'processTree',
      executable: backend.normalizeExecutable({ kind: 'guestPath', path: '/bin/cat' }),
      executableId: 'cat',
      generation: 1,
      operation: 'process.program.spawn',
      policy: {
        access: 'sandboxed',
        mounts: [{ guestPath: '/workspace', rights: ['read'], rootId: 'workspace' }]
      },
      runtimeArgs: []
    }), TypeError)
})

test('declares the network Bridge only when the Host installs its handler', () => {
  const backend = createV86ProcessBackendV1({
    V86: class {},
    handleNetworkRequest: async () => new Response(),
    loadArtifact: async () => new Uint8Array()
  })
  assert.equal(backend.descriptor.features.networkBridge, true)
  assert.equal(backend.descriptor.features.filesystemBridge, false)
  assert.equal(V86_PROCESS_BACKEND_DESCRIPTOR_V1.features.networkBridge, false)
})

test('keeps artifact paths Host-owned and exposes only guest executable paths', () => {
  const backend = createV86ProcessBackendV1({ environmentFactory })
  const normalized = backend.normalizeConfiguration(configuration)
  assert.equal(normalized.artifacts.kernel.artifactId, 'holo-linux')
  assert.equal('path' in normalized.artifacts.kernel, false)
  assert.equal(normalized.supervisor.execGateTimeoutMs, 30_000)
  assert.deepEqual(backend.normalizeExecutable({ kind: 'guestPath', path: '/usr/bin/curl' }), {
    kind: 'guestPath',
    path: '/usr/bin/curl'
  })
  assert.throws(() => backend.normalizeExecutable({ kind: 'hostPath', path: '/usr/bin/curl' }), TypeError)
  assert.throws(() => backend.normalizeExecutable({ kind: 'guestPath', path: '/usr/../bin/curl' }), TypeError)
  assert.throws(() => backend.normalizeExecutable({ kind: 'guestPath', path: '/workspace/tool' }), TypeError)
})

test('rejects incomplete or oversized v86 machine declarations', () => {
  const backend = createV86ProcessBackendV1({ environmentFactory })
  assert.throws(() => backend.normalizeConfiguration({ ...configuration, memoryBytes: 1024 }), TypeError)
  assert.throws(() =>
    backend.normalizeConfiguration({
      ...configuration,
      artifacts: { ...configuration.artifacts, kernel: { artifactId: 'kernel', sha256: 'bad' } }
    }), TypeError)
  assert.throws(() =>
    backend.normalizeConfiguration({
      ...configuration,
      supervisor: { execGateTimeoutMs: 0, protocolVersion: 1 }
    }), TypeError)
  assert.equal(
    backend.normalizeConfiguration({
      ...configuration,
      supervisor: { execGateTimeoutMs: 1500, protocolVersion: 1 }
    }).supervisor.execGateTimeoutMs,
    1500
  )
})

test('negotiates atomic truncation because Host open owns O_TRUNC', async () => {
  const payload = new Uint8Array(40)
  const input = new DataView(payload.buffer)
  input.setUint32(0, payload.byteLength, true)
  input.setUint32(4, 26, true)
  input.setBigUint64(8, 1n, true)
  const output = await new V86FuseBridgeV1(async () => {}).handle({ payload })
  const response = new DataView(output.buffer, output.byteOffset, output.byteLength)
  assert.equal(response.getInt32(4, true), 0)
  assert.equal(response.getUint32(28, true) & (1 << 3), 1 << 3)
})
