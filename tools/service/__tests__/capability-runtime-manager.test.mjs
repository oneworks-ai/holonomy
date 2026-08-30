import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { createNodeProcessBackendRegistryForInstallationV1 } from '../../../adapters/node/src/capability-process-v86-installation.mjs'
import { createServiceCapabilityRuntimeManagerV1 } from '../capability-runtime-manager.mjs'
import { compileSandboxPolicy } from '../sandbox-policy.mjs'
import { runtimeLaunch } from './sandbox-fixture.mjs'

const context = () => ({
  guest: { application: { id: 'example.guest', name: 'Example Guest' } },
  host: { tenantId: 'private-tenant' },
  inspector: { title: 'Example Guest' },
  schemaVersion: 1
})

const limits = {
  maxDirectoryEntries: 32,
  maxOpenHandles: 8,
  maxQueuedEvents: 0,
  maxReadBytes: 4096,
  maxWatchers: 0,
  maxWriteBytes: 4096
}

const capabilityPolicy = network => ({
  device: {
    defaultAccess: 'deny',
    maxEventsPerSecond: 1,
    maxQueuedEvents: 0,
    maxSubscriptions: 0,
    operations: {
      'device.form-factor.read': { access: 'allow', maxPrecision: 'standard', maxPrivacyTier: 0 },
      'device.power.read': { access: 'allow', maxPrecision: 'standard', maxPrivacyTier: 1 }
    }
  },
  filesystem: {
    access: 'sandboxed',
    limits,
    roots: [{
      rights: ['read', 'write'],
      rootId: 'workspace',
      symlinks: 'deny',
      virtualUrl: 'holo-fs://workspace/'
    }]
  },
  ...(network == null ? {} : { network }),
  schemaVersion: 2,
  systemInformation: {
    defaultMode: 'unavailable',
    fields: { 'os.arch': { allowedModes: ['synthetic'], maxPrecision: 'exact' } }
  }
})

const legacyNone = compileSandboxPolicy().policy

const processInput = (target = 'node', source = 'export {}') => ({
  entryUrl: 'app+local://workspace/main.mjs',
  fixture: undefined,
  inspectorMode: 'off',
  launch: runtimeLaunch(target, { source }),
  sandboxPolicy: legacyNone,
  target
})

const request = policy => ({
  context: context(),
  initialMiddlewareId: 'service.continue.v1',
  sandboxPolicy: policy,
  schemaVersion: 1
})

const nativeProcessProfile = {
  backend: {
    backendId: 'native.darwin-seatbelt-v1',
    configuration: {
      runtimeReadPaths: ['/opt/homebrew'],
      sandboxExecutablePath: '/usr/bin/sandbox-exec'
    }
  },
  environment: { allowedScopes: ['processTree'], defaultScope: 'processTree' },
  executables: [{
    executableId: 'fixture-tool',
    executablePath: '/usr/bin/true',
    fixedArgs: [],
    shell: false
  }],
  profile: 'process-profile-v1'
}

const processPolicy = () => ({
  ...capabilityPolicy(),
  process: {
    access: 'sandboxed',
    environment: { allowedNames: [], maxValueBytes: 1024 },
    executables: [{ argumentBytes: 1024, executableId: 'fixture-tool' }],
    limits: {
      maxConcurrentProcesses: 1,
      maxExecutionTimeMs: 1000,
      maxOpenPipes: 3,
      maxProcessTreeDepth: 1,
      maxStderrBytes: 4096,
      maxStdinBytes: 4096,
      maxStdoutBytes: 4096,
      maxTotalProcesses: 1,
      maxWritableRootfsBytes: 0
    },
    mounts: [],
    network: { access: 'none' },
    shell: { access: 'none' }
  }
})

describe('service capability Runtime launch manager', () => {
  it('persists finite public configuration and resolves host bindings per generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-capability-service-'))
    const manager = createServiceCapabilityRuntimeManagerV1({ stateDirectory: directory })
    try {
      const admitted = manager.admit(request(capabilityPolicy()), processInput())
      assert.match(admitted.contextDigest, /^[\da-f]{64}$/u)
      assert.match(admitted.policyDigest, /^[\da-f]{64}$/u)
      assert.equal(admitted.context.host.tenantId, 'private-tenant')
      assert.equal(admitted.ownerId, undefined)
      assert.equal(admitted.providerConfiguration, undefined)

      const prepared = await manager.prepare({
        capabilityRuntime: admitted,
        generation: 3,
        id: 'process_capability',
        ...processInput()
      })
      assert.equal(prepared.processId, 'process_capability')
      assert.equal(prepared.ownerId, 'holonomy-service')
      assert.equal(prepared.runtimeCreation.configuration.context.guest.application.id, 'example.guest')
      assert.equal(prepared.runtimeCreation.configuration.systemProjection.fields['os.arch'].mode, 'synthetic')
      assert.equal(prepared.providerConfiguration.filesystemRoots.length, 1)
      assert.equal(prepared.providerConfiguration.filesystemRoots[0].rootId, 'workspace')
      assert.equal(
        prepared.providerConfiguration.deviceReadings['device.lifecycle.read'].value.visibility,
        'foreground'
      )
      assert.match(prepared.providerConfiguration.filesystemRoots[0].hostPath, /capability-workspaces/u)
      assert.ok(
        prepared.runtimeCreation.hostBindings.providerBindings.every(binding =>
          binding.ownerId === 'holonomy-service' && binding.providerId.endsWith('-g3')
        )
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('never propagates a desktop filesystem path to the Android session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-capability-android-'))
    const manager = createServiceCapabilityRuntimeManagerV1({ stateDirectory: directory })
    try {
      const expected = processInput('android')
      const admitted = manager.admit(request(capabilityPolicy()), expected)
      const prepared = await manager.prepare({
        capabilityRuntime: admitted,
        generation: 1,
        id: 'process_android',
        ...expected
      })
      assert.deepEqual(prepared.providerConfiguration.filesystemRoots, [])
      assert.equal(
        prepared.runtimeCreation.configuration.systemProjection.fields['os.arch'].mode,
        'synthetic'
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('admits the production within-root symlink mode without widening the workspace root', () => {
    const policy = capabilityPolicy()
    policy.filesystem.roots[0].symlinks = 'withinRoot'
    const manager = createServiceCapabilityRuntimeManagerV1()
    const admitted = manager.admit(request(policy), processInput())
    assert.equal(admitted.sandboxPolicy.filesystem.roots[0].rootId, 'workspace')
    assert.equal(admitted.sandboxPolicy.filesystem.roots[0].symlinks, 'withinRoot')
  })

  it.skipIf(process.platform !== 'darwin')(
    'rejects only the Process profile when Android has no compatible installed Backend',
    () => {
      const manager = createServiceCapabilityRuntimeManagerV1({
        processProfiles: { developer: nativeProcessProfile }
      })
      const input = { ...request(processPolicy()), processProfileId: 'developer' }
      assert.doesNotThrow(() => manager.admit(input, processInput('node')))
      assert.throws(
        () => manager.admit(input, processInput('android')),
        error => error.code === 'sandbox.capability_unsupported'
      )
    }
  )

  it('injects only the selected Host-owned v86 installation into the Node session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-v86-manager-'))
    const installation = {
      artifactRoot: directory,
      backendId: 'experimental.v86-v1',
      implementation: 'builtin.v86-v1'
    }
    const profile = {
      backend: {
        backendId: installation.backendId,
        configuration: {
          artifacts: {
            bios: { artifactId: 'bios', sha256: 'a'.repeat(64) },
            initrd: { artifactId: 'initrd', sha256: 'b'.repeat(64) },
            kernel: { artifactId: 'kernel', sha256: 'c'.repeat(64) },
            wasm: { artifactId: 'wasm', sha256: 'd'.repeat(64) }
          },
          memoryBytes: 64 * 1024 * 1024,
          requiredKernelCapabilities: ['process'],
          supervisor: { protocolVersion: 1 }
        }
      },
      environment: { allowedScopes: ['processTree'], defaultScope: 'processTree' },
      executables: [{
        executable: { kind: 'guestPath', path: '/usr/bin/true' },
        executableId: 'fixture-tool',
        fixedArgs: [],
        shell: false
      }],
      profile: 'process-profile-v1'
    }
    try {
      const manager = createServiceCapabilityRuntimeManagerV1({
        processBackendInstallations: { [installation.backendId]: installation },
        processBackendRegistry: createNodeProcessBackendRegistryForInstallationV1(installation),
        processProfiles: { linux: profile },
        stateDirectory: directory
      })
      const admitted = manager.admit(
        { ...request(processPolicy()), processProfileId: 'linux' },
        processInput()
      )
      const prepared = await manager.prepare({
        capabilityRuntime: admitted,
        generation: 2,
        id: 'process_v86',
        ...processInput()
      })
      assert.deepEqual(prepared.providerConfiguration.processBackendInstallation, installation)
      assert.equal(prepared.providerConfiguration.processProfile.backend.backendId, installation.backendId)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it.skipIf(process.platform === 'darwin')(
    'rejects the Darwin Process profile when its Backend is not installed on this Host',
    () => {
      const manager = createServiceCapabilityRuntimeManagerV1({
        processProfiles: { developer: nativeProcessProfile }
      })
      const input = { ...request(processPolicy()), processProfileId: 'developer' }
      assert.throws(
        () => manager.admit(input, processInput('node')),
        error => error.code === 'sandbox.capability_unsupported'
      )
    }
  )

  it('rejects transport widening and unsupported execution surfaces before entry', () => {
    const manager = createServiceCapabilityRuntimeManagerV1()
    const restricted = {
      access: 'restricted',
      allowedOrigins: ['https://api.example'],
      allowedSchemes: ['https'],
      allowPrivateNetwork: false,
      limits: {
        maxChunkBytes: 1024,
        maxConcurrentConnections: 2,
        maxHeaderBytes: 4096,
        maxHeaders: 32,
        maxRedirects: 4,
        maxRequestBodyBytes: 4096,
        maxResponseBodyBytes: 8192,
        maxUrlBytes: 2048,
        socketTimeoutMs: 1000
      },
      requestBodyInspection: { access: 'none' }
    }
    assert.throws(
      () => manager.admit(request(capabilityPolicy(restricted)), processInput()),
      error => error.code === 'service.invalid_request'
    )
    assert.throws(
      () =>
        manager.admit(
          { ...request(capabilityPolicy()), initialMiddlewareId: 'missing.middleware' },
          processInput()
        ),
      error => error.code === 'service.invalid_request'
    )
    assert.throws(
      () => manager.admit(request(capabilityPolicy()), processInput('node', 'await import("./other.mjs")')),
      error => error.code === 'sandbox.capability_unsupported'
    )
    assert.throws(
      () => manager.admit(request(capabilityPolicy()), { ...processInput(), inspectorMode: 'enabled' }),
      error => error.code === 'sandbox.capability_unsupported'
    )
  })

  it('requires exact transport authority while Fetch redirect continuation remains transport-owned', () => {
    const manager = createServiceCapabilityRuntimeManagerV1()
    const legacy = compileSandboxPolicy({
      filesystem: { access: 'none' },
      network: {
        access: 'restricted',
        allowedOrigins: ['https://api.example', 'https://redirect.example'],
        allowedSchemes: ['https'],
        allowPrivateNetwork: true,
        limits: {
          maxChunkBytes: 65_536,
          maxConcurrentConnections: 8,
          maxHeaderBytes: 65_536,
          maxHeaders: 128,
          maxRequestBodyBytes: 1024 * 1024,
          maxResponseBodyBytes: 8 * 1024 * 1024,
          maxUrlBytes: 65_536,
          socketTimeoutMs: 30_000
        }
      },
      schemaVersion: 1
    }).policy
    const expected = { ...processInput(), sandboxPolicy: legacy }
    const exactNetwork = {
      access: 'restricted',
      allowedOrigins: [...legacy.network.allowedOrigins],
      allowedSchemes: [...legacy.network.allowedSchemes],
      allowPrivateNetwork: legacy.network.allowPrivateNetwork,
      limits: { ...legacy.network.limits, maxRedirects: 10 },
      requestBodyInspection: { access: 'none' }
    }
    assert.doesNotThrow(() => manager.admit(request(capabilityPolicy(exactNetwork)), expected))
    assert.throws(
      () =>
        manager.admit(
          request(capabilityPolicy({
            ...exactNetwork,
            allowedOrigins: ['https://api.example'],
            allowPrivateNetwork: false,
            limits: { ...exactNetwork.limits, maxResponseBodyBytes: 1024 }
          })),
          expected
        ),
      error => error.code === 'service.invalid_request'
    )
    assert.throws(
      () =>
        manager.admit(
          request(capabilityPolicy({
            ...exactNetwork,
            limits: { ...exactNetwork.limits, maxRedirects: 4 }
          })),
          expected
        ),
      error => error.code === 'sandbox.capability_unsupported'
    )
  })
})
