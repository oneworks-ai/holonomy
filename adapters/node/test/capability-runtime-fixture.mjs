import { DEFAULT_SANDBOX_POLICY_V2 } from 'holonomy/capability-runtime'
import { createNodeModuleLaunchV1 } from '../src/capability-session.mjs'
import { deviceOperations, reading } from './capability-runtime-device-fixture.mjs'
import { sandboxLimits, sandboxSession } from './sandbox-fixture.mjs'

export const capabilityRuntimeSession = ({
  behavior = 'allow',
  deviceTarget = 'node',
  entryUrl,
  hostPath,
  moduleRootUrl,
  network,
  processBackendInstallation,
  processLimits = {},
  processMounts = [],
  processNetwork = { access: 'none' },
  processProfile,
  source
}) => {
  const userModules = [{ source, url: entryUrl }]
  const ownerId = 'node-host'
  const provider = module => ({
    module,
    ownerId,
    providerId: `${module.replaceAll('.', '-')}-provider`,
    providerVersion: '1'
  })
  const launch = createNodeModuleLaunchV1({ moduleRootUrl, userEntryUrl: entryUrl, userModules })
  const policy = structuredClone(DEFAULT_SANDBOX_POLICY_V2)
  policy.filesystem = {
    access: 'sandboxed',
    limits: {
      maxDirectoryEntries: 32,
      maxOpenHandles: 8,
      maxReadBytes: 4096,
      maxWatchers: 2,
      maxWriteBytes: 4096
    },
    roots: [{
      rights: ['create', 'delete', 'list', 'move', 'read', 'watch', 'write'],
      rootId: 'workspace',
      symlinks: 'deny',
      virtualUrl: 'holo-fs://workspace/'
    }]
  }
  policy.device = {
    defaultAccess: 'deny',
    maxEventsPerSecond: 16,
    maxSubscriptions: 2,
    operations: {
      'device.events.subscribe': { access: 'allow', maxPrecision: 'standard', maxPrivacyTier: 1 },
      'device.form-factor.read': { access: 'allow', maxPrecision: 'standard', maxPrivacyTier: 0 },
      'device.lifecycle.read': { access: 'allow', maxPrecision: 'standard', maxPrivacyTier: 1 },
      'device.summary.read': { access: 'allow', maxPrecision: 'standard', maxPrivacyTier: 1 }
    }
  }
  policy.systemInformation = {
    defaultMode: 'unavailable',
    fields: { 'os.arch': { allowedModes: ['synthetic'], maxPrecision: 'exact' } }
  }
  if (processProfile != null) {
    policy.process = {
      access: 'sandboxed',
      environment: { allowedNames: [], maxValueBytes: 1024 },
      executables: processProfile.executables.map(item => ({
        argumentBytes: 64 * 1024,
        executableId: item.executableId
      })),
      limits: {
        maxConcurrentProcesses: 4,
        maxExecutionTimeMs: 5000,
        maxOpenPipes: 12,
        maxProcessTreeDepth: 1,
        maxStderrBytes: 64 * 1024,
        maxStdinBytes: 64 * 1024,
        maxStdoutBytes: 64 * 1024,
        maxTotalProcesses: 16,
        maxWritableRootfsBytes: 0,
        ...processLimits
      },
      mounts: processMounts,
      network: processNetwork,
      shell: processProfile.defaultShellExecutableId == null
        ? { access: 'none' }
        : { access: 'restricted', executableId: processProfile.defaultShellExecutableId }
    }
  }
  const providerModules = ['host.device', 'host.fs', 'host.system']
  if (processProfile != null) providerModules.push('host.process')
  if (network != null) {
    policy.network = {
      access: network.access,
      allowedOrigins: [network.origin],
      allowedSchemes: [new URL(network.origin).protocol.slice(0, -1)],
      allowPrivateNetwork: network.privateNetwork === true,
      limits: { ...sandboxLimits, maxRedirects: 10 },
      requestBodyInspection: { access: 'none' }
    }
    providerModules.push(network.access === 'mockOnly' ? 'host.network.mock' : 'host.network')
  }
  const legacyNetwork = network == null
    ? {}
    : {
      ...sandboxSession({
        access: network.access,
        origin: network.origin,
        privateNetwork: network.privateNetwork === true
      }),
      networkRules: network.rules
    }
  return {
    ...legacyNetwork,
    capabilityRuntime: {
      initialMiddleware: { behavior, ...(behavior === 'timeout' ? { timeoutMs: 10 } : {}) },
      ownerId,
      processId: 'process-capability-e2e',
      providerConfiguration: {
        deviceReadings: {
          'device.form-factor.read': reading('desktop'),
          'device.lifecycle.read': reading({
            interactive: true,
            memoryPressure: 'normal',
            visibility: 'foreground'
          })
        },
        deviceSummary: {
          display: { observedAt: 100, precision: 'none', revision: 1, status: 'unsupported' },
          formFactor: reading('desktop'),
          input: { observedAt: 100, precision: 'none', revision: 1, status: 'unsupported' },
          lifecycle: reading({ interactive: true, memoryPressure: 'normal', visibility: 'foreground' }),
          power: { observedAt: 100, precision: 'none', revision: 1, status: 'unsupported' },
          schemaVersion: 1
        },
        filesystemRoots: [{ hostPath, rootId: 'workspace' }],
        networkProvider: network?.access === 'mockOnly' ? 'host.network.mock' : 'host.network',
        ...(processBackendInstallation == null ? {} : { processBackendInstallation }),
        ...(processProfile == null ? {} : { processProfile })
      },
      runtimeCreation: {
        configuration: {
          context: {
            guest: { application: { id: 'example.guest', name: 'Example Guest' } },
            host: { tenantId: 'tenant-a' },
            inspector: { title: 'Example Guest' },
            schemaVersion: 1
          },
          deviceProviderDescriptor: {
            operations: deviceOperations(deviceTarget),
            providerVersion: '1.0.0',
            schemaVersion: 1,
            target: deviceTarget
          },
          inspector: { enabled: false },
          launch,
          sandboxPolicy: policy,
          schemaVersion: 1,
          systemProjection: {
            fields: { 'os.arch': { mode: 'synthetic', precision: 'exact', value: 'arm64' } },
            schemaVersion: 1
          }
        },
        hostBindings: {
          engineGate: { bindingId: 'engine-gate', ownerId, version: '1' },
          initialMiddlewareSet: { bindingId: 'middleware', ownerId, version: '1' },
          initialObservers: [],
          moduleResolver: { bindingId: 'resolver', ownerId, version: '1' },
          providerBindings: providerModules.map(provider)
        }
      }
    },
    entryUrl,
    moduleRootUrl,
    runtimeModules: [],
    syntheticModules: {},
    userModules
  }
}
