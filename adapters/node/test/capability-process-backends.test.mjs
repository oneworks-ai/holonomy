import assert from 'node:assert/strict'
import process from 'node:process'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { NODE_PROCESS_BACKEND_REGISTRY_V1, NodeProcessBackendRegistryV1 } from '../src/capability-process-backend.mjs'
import { normalizeNodeProcessProfileV1 } from '../src/capability-process-profile.mjs'
import { NodeProcessProviderV1 } from '../src/capability-process-provider.mjs'

const executable = {
  executableId: 'tool',
  executablePath: '/usr/bin/true',
  fixedArgs: [],
  shell: false
}

const profile = (backend, environment = { allowedScopes: ['processTree'], defaultScope: 'processTree' }) => ({
  backend,
  environment,
  executables: [executable],
  profile: 'process-profile-v1'
})

const backend = (descriptor, overrides = {}) => ({
  closeGeneration() {},
  descriptor,
  normalizeConfiguration(value) {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid')
    return Object.freeze({ ...value })
  },
  normalizeExecutable(value) {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid')
    return Object.freeze({ ...value })
  },
  prepareLaunch() {
    throw new Error('not used')
  },
  spawn() {
    throw new Error('not used')
  },
  validateProfile() {},
  ...(descriptor.features.synchronousSpawn
    ? {
      spawnSync() {
        throw new Error('not used')
      }
    }
    : {}),
  ...overrides
})

test('publishes a backend descriptor separately from the Host process profile', () => {
  const descriptor = {
    backendId: 'native.darwin-seatbelt-v1',
    binaryFormats: ['host-native'],
    environmentScopes: ['processTree'],
    family: 'native',
    features: {
      filesystemBridge: false,
      networkBridge: false,
      pty: false,
      shell: true,
      signals: true,
      snapshots: false,
      synchronousSpawn: true
    },
    platforms: ['desktop', 'node'],
    stability: 'stable',
    version: 1
  }
  assert.deepEqual(
    NODE_PROCESS_BACKEND_REGISTRY_V1.descriptors(),
    process.platform === 'darwin' ? [descriptor] : []
  )
  const input = profile({
    backendId: 'native.darwin-seatbelt-v1',
    configuration: {
      runtimeReadPaths: ['/opt/homebrew'],
      sandboxExecutablePath: '/usr/bin/sandbox-exec'
    }
  })
  if (process.platform !== 'darwin') {
    assert.throws(() => normalizeNodeProcessProfileV1(input))
    return
  }
  const value = normalizeNodeProcessProfileV1(input)
  assert.equal(value.backend.backendId, 'native.darwin-seatbelt-v1')
  assert.equal('platforms' in value.backend, false)
  assert.throws(() =>
    normalizeNodeProcessProfileV1(profile({
      backendId: 'native.darwin-seatbelt-v1',
      configuration: {
        runtimeReadPaths: ['/opt/homebrew'],
        sandboxExecutablePath: '/definitely/missing/holonomy/sandbox-exec'
      }
    }))
  )
})

test('rejects a Backend that is installed for a different Runtime platform', () => {
  const registry = new NodeProcessBackendRegistryV1([
    backend({
      backendId: 'test.desktop-v1',
      binaryFormats: ['packaged-wasm'],
      environmentScopes: ['processTree'],
      family: 'virtual-kernel',
      features: {
        filesystemBridge: false,
        networkBridge: false,
        pty: false,
        shell: false,
        signals: true,
        snapshots: false,
        synchronousSpawn: false
      },
      platforms: ['desktop'],
      stability: 'experimental',
      version: 1
    })
  ])
  const input = profile({ backendId: 'test.desktop-v1', configuration: {} })
  assert.throws(() => normalizeNodeProcessProfileV1(input, registry))
  assert.equal(normalizeNodeProcessProfileV1(input, registry, 'desktop').backend.backendId, 'test.desktop-v1')
})

test('lets an installed WASM backend own shared and isolated environment scopes', () => {
  const registry = new NodeProcessBackendRegistryV1([
    backend({
      backendId: 'test.virtual-machine-v1',
      binaryFormats: ['linux-x86-32'],
      environmentScopes: ['runtime', 'processTree'],
      family: 'virtual-machine',
      features: {
        filesystemBridge: true,
        networkBridge: true,
        pty: true,
        shell: true,
        signals: true,
        snapshots: true,
        synchronousSpawn: false
      },
      platforms: ['node'],
      stability: 'experimental',
      version: 1
    })
  ])
  const value = normalizeNodeProcessProfileV1(
    profile(
      { backendId: 'test.virtual-machine-v1', configuration: { imageId: 'fixture-x86' } },
      { allowedScopes: ['runtime', 'processTree'], defaultScope: 'runtime' }
    ),
    registry
  )
  assert.deepEqual(value.environment, {
    allowedScopes: ['processTree', 'runtime'],
    defaultScope: 'runtime'
  })
  assert.deepEqual(value.executables[0].executable, {
    kind: 'hostPath',
    path: '/usr/bin/true'
  })
  assert.equal('executablePath' in value.executables[0], false)
})

test('lets the selected Backend own its executable locator schema', () => {
  const registry = new NodeProcessBackendRegistryV1([
    backend({
      backendId: 'test.virtual-machine-v1',
      binaryFormats: ['linux-x86-32'],
      environmentScopes: ['processTree'],
      family: 'virtual-machine',
      features: {
        filesystemBridge: true,
        networkBridge: true,
        pty: false,
        shell: true,
        signals: true,
        snapshots: true,
        synchronousSpawn: false
      },
      platforms: ['node'],
      stability: 'experimental',
      version: 1
    }, {
      normalizeExecutable(value) {
        if (value?.kind !== 'guestPath' || value.path !== '/usr/bin/tool') throw new TypeError('invalid')
        return Object.freeze({ kind: value.kind, path: value.path })
      }
    })
  ])
  const input = {
    ...profile({ backendId: 'test.virtual-machine-v1', configuration: {} }),
    executables: [{
      executable: { kind: 'guestPath', path: '/usr/bin/tool' },
      executableId: 'tool',
      fixedArgs: [],
      shell: false
    }]
  }
  const value = normalizeNodeProcessProfileV1(input, registry)
  assert.deepEqual(value.executables[0].executable, {
    kind: 'guestPath',
    path: '/usr/bin/tool'
  })
  assert.throws(() =>
    normalizeNodeProcessProfileV1({
      ...input,
      executables: [{
        ...input.executables[0],
        executablePath: '/usr/bin/tool'
      }]
    }, registry)
  )
})

test('rejects an unavailable backend and a scope the backend cannot isolate', () => {
  assert.throws(() =>
    normalizeNodeProcessProfileV1(profile({
      backendId: 'test.not-installed-v1',
      configuration: {}
    }))
  )
  assert.throws(() =>
    normalizeNodeProcessProfileV1(profile(
      {
        backendId: 'native.darwin-seatbelt-v1',
        configuration: {
          runtimeReadPaths: ['/opt/homebrew'],
          sandboxExecutablePath: '/usr/bin/sandbox-exec'
        }
      },
      { allowedScopes: ['runtime'], defaultScope: 'runtime' }
    ))
  )
})

test('rejects shell declarations when an installed backend does not implement shell semantics', () => {
  const registry = new NodeProcessBackendRegistryV1([
    backend({
      backendId: 'test.wasix-v1',
      binaryFormats: ['wasix'],
      environmentScopes: ['processTree'],
      family: 'wasix',
      features: {
        filesystemBridge: true,
        networkBridge: true,
        pty: false,
        shell: false,
        signals: false,
        snapshots: false,
        synchronousSpawn: false
      },
      platforms: ['node'],
      stability: 'experimental',
      version: 1
    })
  ])
  assert.throws(() =>
    normalizeNodeProcessProfileV1({
      ...profile({ backendId: 'test.wasix-v1', configuration: {} }),
      defaultShellExecutableId: 'tool',
      executables: [{ ...executable, shell: true }]
    }, registry)
  )
})

test('fences backend cleanup to the exact Runtime generation', async () => {
  const closed = []
  const implementation = backend({
    backendId: 'test.virtual-machine-v1',
    binaryFormats: ['linux-x86-32'],
    environmentScopes: ['runtime', 'processTree'],
    family: 'virtual-machine',
    features: {
      filesystemBridge: true,
      networkBridge: true,
      pty: true,
      shell: true,
      signals: true,
      snapshots: true,
      synchronousSpawn: false
    },
    platforms: ['desktop', 'node'],
    stability: 'experimental',
    version: 1
  }, {
    closeGeneration(generation) {
      closed.push(generation)
    }
  })
  const registry = new NodeProcessBackendRegistryV1([implementation])
  const normalized = normalizeNodeProcessProfileV1(
    profile(
      { backendId: 'test.virtual-machine-v1', configuration: { imageId: 'fixture-x86' } },
      { allowedScopes: ['runtime', 'processTree'], defaultScope: 'runtime' }
    ),
    registry
  )
  const provider = new NodeProcessProviderV1(
    normalized,
    {
      limits: { maxConcurrentProcesses: 1, maxTotalProcesses: 1 }
    },
    7,
    registry
  )
  await provider.close()
  assert.deepEqual(closed, [7])
})
