import {
  DEFAULT_SANDBOX_POLICY_V2,
  admitRuntimeCreationV1,
  canonicalizeFilesystemResource,
  canonicalizeSystemInformationFieldResource,
  compileDeviceProviderDescriptorV1,
  trustedInvocationValueFromSnapshotV1
} from '../../../src/capability-runtime/index.js'
import type {
  CapabilityBrokerProviderV1,
  CapabilityProviderAuthorityV1,
  HoloInvocationContextV1,
  HoloMiddlewareRegistrationV1,
  InitialMiddlewareSetV1,
  RuntimeCreationSpecV1,
  SandboxPolicyV2
} from '../../../src/capability-runtime/index.js'

export const snapshot = (value: unknown, direction: 'argument' | 'result') =>
  trustedInvocationValueFromSnapshotV1({
    direction,
    root: node(value),
    schemaVersion: 1
  }, direction)

const node = (value: unknown): unknown => {
  if (value === undefined) return { entries: [], kind: 'object' }
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) {
    return { kind: 'scalar', value }
  }
  if (Array.isArray(value)) return { items: value.map(node), kind: 'array' }
  return {
    entries: Object.entries(value as Record<string, unknown>).map(([key, item]) => ({ key, value: node(item) })),
    kind: 'object'
  }
}

const providerBinding = (module: string) => ({
  module,
  ownerId: 'host-owner',
  providerId: `${module.replaceAll('.', '-')}-provider`,
  providerVersion: '1'
})

export const creation = (
  bindings: Readonly<Record<string, unknown>>,
  middleware: InitialMiddlewareSetV1 = { registrations: [], schemaVersion: 1 },
  policy: SandboxPolicyV2 = policyV2()
) => {
  const providers = Object.entries(bindings).map(([module, value]) => [providerBinding(module), value] as const)
  const spec: RuntimeCreationSpecV1 = {
    configuration: {
      context: { host: { tenantId: 'tenant-a' }, schemaVersion: 1 },
      deviceProviderDescriptor: compileDeviceProviderDescriptorV1(deviceDescriptor()),
      inspector: { enabled: false },
      launch: {
        entryUrl: 'app+local://workspace/main.mjs',
        moduleCount: 1,
        moduleGraphDigest: '1'.repeat(64),
        moduleRootUrl: 'app+local://workspace/',
        totalSourceBytes: 16
      },
      sandboxPolicy: policy,
      schemaVersion: 1,
      systemProjection: {
        fields: { 'os.arch': { mode: 'synthetic', precision: 'exact', value: 'arm64' } },
        schemaVersion: 1
      }
    },
    hostBindings: {
      engineGate: { bindingId: 'engine-gate', ownerId: 'host-owner', version: '1' },
      initialMiddlewareSet: { bindingId: 'middleware', ownerId: 'host-owner', version: '1' },
      initialObservers: [],
      moduleResolver: { bindingId: 'resolver', ownerId: 'host-owner', version: '1' },
      providerBindings: providers.map(([registration]) => registration)
    }
  }
  const resolved = new Map<string, unknown>([
    ['engine-gate', {}],
    ['middleware', middleware],
    ['resolver', {}],
    ...providers.map(([registration, value]) => [registration.providerId, value] as const)
  ])
  return admitRuntimeCreationV1(spec, {
    expectedOwnerId: 'host-owner',
    generation: 1,
    processId: 'process-broker',
    resolveBinding: reference => resolved.get(reference.bindingId)
  })
}

export const provider = (
  module: string,
  execution: 'async' | 'sync',
  result: unknown,
  invoke?: (
    context: HoloInvocationContextV1,
    authority: CapabilityProviderAuthorityV1
  ) => unknown
): CapabilityBrokerProviderV1 => ({
  execution,
  invoke: (context, authority) => {
    const custom = invoke?.(context, authority)
    if (custom !== undefined) return custom as never
    const terminal = authority.complete(snapshot(result, 'result'))
    return execution === 'async' ? Promise.resolve(terminal) : terminal
  },
  module
})

export const fsResource = () =>
  canonicalizeFilesystemResource(
    'holo-fs://workspace/demo.txt',
    'demo.txt'
  )
export const systemResource = () => canonicalizeSystemInformationFieldResource('os.arch', 'Architecture')

export const middleware = (
  id: string,
  fn: HoloMiddlewareRegistrationV1['middleware'],
  execution: 'async' | 'sync' = 'async',
  timeoutMs?: number
): HoloMiddlewareRegistrationV1 => ({
  execution,
  layer: 'application',
  matcher: {},
  middleware: fn,
  registrationId: id,
  ...(timeoutMs == null ? {} : { timeoutMs })
})

export const policyV2 = (): SandboxPolicyV2 =>
  structuredClone({
    ...DEFAULT_SANDBOX_POLICY_V2,
    device: {
      defaultAccess: 'deny',
      maxEventsPerSecond: 10,
      maxSubscriptions: 1,
      operations: {
        'device.form-factor.read': { access: 'allow', maxPrecision: 'standard', maxPrivacyTier: 0 }
      }
    },
    filesystem: {
      access: 'sandboxed',
      limits: {
        maxDirectoryEntries: 32,
        maxOpenHandles: 8,
        maxReadBytes: 1024,
        maxWatchers: 2,
        maxWriteBytes: 1024
      },
      roots: [{
        rights: ['read', 'write'],
        rootId: 'workspace',
        symlinks: 'deny',
        virtualUrl: 'holo-fs://workspace/'
      }]
    },
    systemInformation: {
      defaultMode: 'unavailable',
      fields: { 'os.arch': { allowedModes: ['synthetic'], maxPrecision: 'exact' } }
    }
  })

const deviceDescriptor = () => ({
  operations: [
    'device.connectivity.cellular.state.read',
    'device.connectivity.read',
    'device.connectivity.wifi.identity.read',
    'device.connectivity.wifi.state.read',
    'device.display.read',
    'device.events.subscribe',
    'device.form-factor.read',
    'device.input.read',
    'device.lifecycle.read',
    'device.media.capabilities.read',
    'device.power.read',
    'device.security.capabilities.read',
    'device.sensor.capabilities.read',
    'device.summary.read',
    'device.thermal.read'
  ].map(operation => ({
    eventKinds: [],
    maxPrecision: ['device.form-factor.read', 'device.lifecycle.read', 'device.summary.read'].includes(operation)
      ? 'standard'
      : 'none',
    operation,
    permissionModel: ['device.form-factor.read', 'device.lifecycle.read', 'device.summary.read'].includes(operation)
      ? 'host'
      : 'none',
    supportLevel: ['device.form-factor.read', 'device.lifecycle.read', 'device.summary.read'].includes(operation)
      ? 'required'
      : 'unsupported'
  })),
  providerVersion: '1.0.0',
  schemaVersion: 1,
  target: 'node'
})
