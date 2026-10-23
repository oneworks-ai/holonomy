/* eslint-disable max-lines -- Native Process admission shares the existing policy and Backend fixtures. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { createNodeProcessBackendRegistryForInstallationV1 } from '../../../adapters/node/src/capability-process-v86-installation.mjs'
import { createServiceCapabilityRuntimeManagerV1 } from '../capability-runtime-manager.mjs'
import { materializeNativeLaunch } from '../native-launch-materialization.mjs'
import { privateLaunchLine } from '../native-target-adapter.mjs'
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

const nativeInput = (source, extraModules = []) => {
  const entryUrl = 'app://workspace/main.mjs'
  return {
    entryUrl,
    fixture: undefined,
    inspectorMode: 'off',
    launch: {
      argv: [entryUrl],
      command: 'run',
      entryUrl,
      moduleRootUrl: 'app://workspace/',
      modules: [{ source, url: entryUrl }, ...extraModules],
      schemaVersion: 2,
      target: 'native'
    },
    sandboxPolicy: legacyNone,
    target: 'native'
  }
}

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

const nativeProcessPolicy = () => {
  const policy = processPolicy()
  policy.device.operations = {}
  policy.process.limits.maxProcessTreeDepth = 2
  return policy
}

const controlledStringsPolicy = () => ({
  ...capabilityPolicy(),
  codeGeneration: {
    dynamicImport: { access: 'none' },
    strings: {
      access: 'controlled',
      decisionTimeoutMs: 1000,
      maxOperations: 4,
      maxSourceBytes: 4096
    },
    wasm: { access: 'none' }
  }
})

const nativeCodePolicy = () => ({
  codeGeneration: {
    dynamicImport: { access: 'controlled', decisionTimeoutMs: 1000, maxOperations: 2, maxSourceBytes: 4096 },
    strings: { access: 'none' },
    wasm: { access: 'controlled', decisionTimeoutMs: 1000, maxOperations: 1, maxSourceBytes: 4096 }
  },
  schemaVersion: 2
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

  it.skipIf(process.platform !== 'darwin')(
    'prepares only an explicit Darwin profile for Native without publishing Host paths',
    async () => {
      const manager = createServiceCapabilityRuntimeManagerV1({
        processProfiles: { developer: nativeProcessProfile }
      })
      const expected = processInput('native')
      const admitted = manager.admit(
        { ...request(nativeProcessPolicy()), processProfileId: 'developer' },
        expected
      )
      assert.equal(admitted.processProfileId, 'developer')
      assert.equal(admitted.sandboxPolicy.process.limits.maxProcessTreeDepth, 2)
      assert.equal(JSON.stringify(admitted).includes('/usr/bin/true'), false)
      const prepared = await manager.prepare({
        ...expected,
        capabilityRuntime: admitted,
        generation: 1,
        id: 'process_native'
      })
      assert.equal(prepared.processProfileId, 'developer')
      assert.equal(prepared.processProfile.executables[0].executable.path, '/usr/bin/true')
      const writable = nativeProcessPolicy()
      writable.process.limits.maxWritableRootfsBytes = 1024
      assert.throws(
        () => manager.admit({ ...request(writable), processProfileId: 'developer' }, expected),
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
      assert.throws(
        () =>
          manager.admit(
            { ...request(nativeProcessPolicy()), processProfileId: 'linux' },
            processInput('native')
          ),
        error => error.code === 'sandbox.capability_unsupported'
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

  it('admits controlled strings only when the Node Host installs an M4 Engine Gate', () => {
    const unavailable = createServiceCapabilityRuntimeManagerV1()
    assert.throws(
      () => unavailable.admit(request(controlledStringsPolicy()), processInput()),
      error => error.code === 'sandbox.capability_unsupported'
    )

    const available = createServiceCapabilityRuntimeManagerV1({ engineGate: () => ({ action: 'allow' }) })
    assert.equal(
      available.admit(request(controlledStringsPolicy()), processInput()).sandboxPolicy.codeGeneration.strings.access,
      'controlled'
    )
    assert.throws(
      () => available.admit(request(controlledStringsPolicy()), processInput('android')),
      error => error.code === 'sandbox.capability_unsupported'
    )

    const dynamicImport = controlledStringsPolicy()
    dynamicImport.codeGeneration.strings = { access: 'none' }
    dynamicImport.codeGeneration.dynamicImport = {
      access: 'controlled',
      decisionTimeoutMs: 1000,
      maxOperations: 2,
      maxSourceBytes: 4096
    }
    assert.equal(
      available.admit(
        request(dynamicImport),
        processInput('node', "await import('./other.mjs')")
      ).sandboxPolicy.codeGeneration.dynamicImport.access,
      'controlled'
    )

    const wasm = controlledStringsPolicy()
    wasm.codeGeneration.wasm = {
      access: 'controlled',
      decisionTimeoutMs: 1000,
      maxOperations: 1,
      maxSourceBytes: 4096
    }
    assert.equal(
      available.admit(request(wasm), processInput()).sandboxPolicy.codeGeneration.wasm.access,
      'controlled'
    )
    assert.throws(
      () => available.admit(request(wasm), processInput('android')),
      error => error.code === 'sandbox.capability_unsupported'
    )
  })

  it('carries controlled Native Wasm and dynamic-import Policy through private staging without a Service callback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-native-gates-stage-'))
    const manager = createServiceCapabilityRuntimeManagerV1({ stateDirectory: directory })
    const lazyUrl = 'app://workspace/lazy.mjs'
    const expected = nativeInput(
      "await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])); await import('./lazy.mjs')",
      [{ source: 'export const value = 42', url: lazyUrl }]
    )
    try {
      const admitted = manager.admit(request(nativeCodePolicy()), expected)
      const process = { ...expected, capabilityRuntime: admitted, generation: 1, id: 'process_native_gates' }
      const prepared = await manager.prepare(process)
      assert.equal(admitted.sandboxPolicy.codeGeneration.wasm.access, 'controlled')
      assert.equal(admitted.sandboxPolicy.codeGeneration.dynamicImport.access, 'controlled')
      assert.equal(prepared.policyDigest, admitted.policyDigest)
      assert.deepEqual(prepared.policy, admitted.sandboxPolicy)
      assert.equal(Object.hasOwn(prepared, 'engineGate'), false)

      const staged = await materializeNativeLaunch(process, directory, prepared)
      const hostConfig = JSON.parse(await readFile(staged.hostConfigPath, 'utf8'))
      const privateLaunch = JSON.parse(privateLaunchLine(process, staged))
      assert.deepEqual(hostConfig.sandboxPolicy.codeGeneration, admitted.sandboxPolicy.codeGeneration)
      assert.deepEqual(privateLaunch.hostConfig.sandboxPolicy.codeGeneration, admitted.sandboxPolicy.codeGeneration)
      assert.deepEqual(hostConfig.plugins, [])
      assert(privateLaunch.moduleAllowlist.includes(lazyUrl))
      assert.equal(await readFile(join(staged.workspaceRoot, 'lazy.mjs'), 'utf8'), 'export const value = 42')
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('keeps Native none, wrong-target and malformed requests outside the staging boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-native-gates-deny-'))
    const unavailable = createServiceCapabilityRuntimeManagerV1({ stateDirectory: directory })
    const callbackOnly = createServiceCapabilityRuntimeManagerV1({
      engineGate: () => ({ action: 'allow' }),
      stateDirectory: directory
    })
    const source = "globalThis.entryRan = true; await import('./lazy.mjs')"
    const expected = nativeInput(source, [{ source: 'export default 1', url: 'app://workspace/lazy.mjs' }])
    try {
      const none = nativeCodePolicy()
      none.codeGeneration.dynamicImport = { access: 'none' }
      none.codeGeneration.wasm = { access: 'none' }
      assert.throws(
        () => unavailable.admit(request(none), expected),
        error => error.code === 'sandbox.capability_unsupported'
      )
      assert.equal(
        unavailable.admit(request(none), nativeInput('export {}')).sandboxPolicy.codeGeneration.wasm.access,
        'none'
      )
      assert.throws(
        () => unavailable.admit(request(nativeCodePolicy()), processInput('node', source)),
        error => error.code === 'sandbox.capability_unsupported'
      )
      assert.throws(
        () => callbackOnly.admit(request(nativeCodePolicy()), processInput('android', source)),
        error => error.code === 'sandbox.capability_unsupported'
      )
      const malformed = nativeCodePolicy()
      malformed.codeGeneration.wasm.unrecognized = true
      assert.throws(
        () => unavailable.admit(request(malformed), expected),
        error => error.code === 'service.invalid_request'
      )
      assert.deepEqual(await readdir(directory), [])
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('admits Native Inspector policy through the Native Host Gate without a Service Gate', () => {
    const manager = createServiceCapabilityRuntimeManagerV1()
    const nativePolicy = {
      schemaVersion: 2,
      codeGeneration: {
        dynamicImport: { access: 'none' },
        strings: {
          access: 'controlled',
          decisionTimeoutMs: 1_000,
          maxOperations: 4,
          maxSourceBytes: 4_096
        },
        wasm: { access: 'none' }
      },
      inspector: { evaluate: true }
    }
    const native = { ...processInput('native'), inspectorMode: 'break' }
    const admitted = manager.admit(request(nativePolicy), native)
    assert.equal(admitted.sandboxPolicy.inspector.evaluate, true)
    assert.equal(admitted.sandboxPolicy.codeGeneration.strings.access, 'controlled')
    assert.throws(
      () => manager.admit(request(nativePolicy), { ...processInput('android'), inspectorMode: 'break' }),
      error => error.code === 'sandbox.capability_unsupported'
    )
  })

  it('admits only pre-registered Node Runtime Observer bindings', () => {
    const observerRegistry = {
      'service.script-observer': {
        observer: () => undefined,
        registration: { events: ['script.compiled'] }
      }
    }
    const manager = createServiceCapabilityRuntimeManagerV1({ observerRegistry })
    const policy = capabilityPolicy()
    policy.diagnostics = {
      maxObserverCallbackMs: 100,
      maxQueuedEvents: 8,
      maxSourceReadBytes: 0,
      observerEvents: ['script.compiled'],
      retentionMs: 0,
      sourceReader: 'metadataOnly'
    }
    const admitted = manager.admit(
      { ...request(policy), initialObserverIds: ['service.script-observer'] },
      processInput()
    )
    assert.deepEqual(admitted.initialObserverIds, ['service.script-observer'])
    assert.throws(
      () =>
        manager.admit(
          { ...request(policy), initialObserverIds: ['service.missing-observer'] },
          processInput()
        ),
      error => error.code === 'service.invalid_request'
    )
    assert.throws(
      () =>
        manager.admit(
          { ...request(policy), initialObserverIds: ['service.script-observer'] },
          processInput('android')
        ),
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
