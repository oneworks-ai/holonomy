import type { MaterializationInputV1 } from './broker-policy-types.js'
import { canonicalizeFilesystemResource } from './canonical-resources.js'
import type { JsonValueV1 } from './json-types.js'
import type { BuiltInCapabilityNameV1 } from './operation-types.js'

const fsRights = (operation: string, args: unknown): readonly string[] => {
  if (operation === 'filesystem.file.read' || operation.startsWith('filesystem.metadata.')) return ['read']
  if (operation === 'filesystem.file.write') return ['write']
  if (operation === 'filesystem.directory.read') return ['list']
  if (operation === 'filesystem.directory.create') return ['create']
  if (operation === 'filesystem.entry.rename') return ['move']
  if (operation === 'filesystem.entry.unlink') return ['delete']
  if (operation === 'filesystem.watch.subscribe' || operation === 'filesystem.watch.close') return ['watch']
  if (operation === 'filesystem.file.open') {
    const flag = (args as { flag?: unknown }).flag
    if (typeof flag === 'string' && flag.includes('+')) return ['read', 'write']
    return typeof flag === 'string' && flag.startsWith('r') ? ['read'] : ['write']
  }
  return ['read']
}

const fsConstraints = (input: MaterializationInputV1, available: boolean) => {
  const policy = input.policy.filesystem
  if (policy.access !== 'sandboxed' || input.resource.kind !== 'filesystem') return null
  const resource = input.resource
  const root = policy.roots.find(item => item.rootId === resource.rootId)
  const rights = fsRights(input.descriptor.operation, input.arguments.value)
  if (root == null || !rights.every(right => root.rights.includes(right as never))) return null
  let pathPrefixSegments = resource.pathSegments
  if (input.descriptor.operation === 'filesystem.entry.rename') {
    const destination = canonicalizeFilesystemResource(
      (input.arguments.value as { to?: unknown }).to,
      'rename destination'
    )
    if (destination.rootId !== resource.rootId) return null
    let shared = 0
    while (
      shared < destination.pathSegments.length && shared < resource.pathSegments.length &&
      destination.pathSegments[shared] === resource.pathSegments[shared]
    ) shared += 1
    pathPrefixSegments = resource.pathSegments.slice(0, shared)
  }
  return {
    limits: policy.limits,
    roots: [{
      pathPrefixSegments: available ? [] : pathPrefixSegments,
      rights: available ? root.rights : rights,
      rootId: root.rootId,
      symlinks: root.symlinks
    }]
  } as unknown as Readonly<Record<string, JsonValueV1>>
}

const networkConstraints = (input: MaterializationInputV1, name: BuiltInCapabilityNameV1, available: boolean) => {
  const policy = input.policy.network
  if (policy.access === 'none' || input.resource.kind !== 'network') return null
  const mock = name === 'host.network.mock'
  if (!mock && policy.access !== 'restricted') return null
  if (!policy.allowedOrigins.includes(input.resource.origin)) return null
  const scheme = new URL(input.resource.origin).protocol.slice(0, -1)
  if (!policy.allowedSchemes.includes(scheme as never)) return null
  return {
    allowPrivateNetwork: mock ? false : policy.allowPrivateNetwork,
    inspectRequestBodyBytes: policy.requestBodyInspection.access === 'bounded'
      ? policy.requestBodyInspection.maxBytes
      : 0,
    limits: policy.limits,
    mode: mock ? 'mockOnly' : 'restricted',
    origins: available ? policy.allowedOrigins : [input.resource.origin],
    schemes: available ? policy.allowedSchemes : [scheme]
  }
}

const deviceConstraints = (input: MaterializationInputV1) => {
  if (input.resource.kind !== 'deviceField') return null
  const resource = input.resource
  const ceiling = input.policy.device.operations[resource.operation]
  const provider = input.deviceProviderDescriptor?.operations.find(item => item.operation === resource.operation)
  if (provider == null || provider.supportLevel === 'unsupported') return null
  if (ceiling == null || resource.privacyTier > ceiling.maxPrivacyTier) return null
  const precision = ['redacted', 'coarse', 'standard', 'exact']
  const maxPrecision = precision[
    Math.min(precision.indexOf(ceiling.maxPrecision), precision.indexOf(provider.maxPrecision))
  ]
  if (maxPrecision == null || maxPrecision === 'redacted') return null
  return {
    maxPrecision,
    maxPrivacyTier: ceiling.maxPrivacyTier,
    maxQueuedEvents: 0,
    operations: [resource.operation]
  }
}

const systemConstraints = (input: MaterializationInputV1) => {
  if (input.resource.kind !== 'systemField') return null
  const ceiling = input.policy.systemInformation.fields[input.resource.field]
  const projection = input.systemProjection.fields[input.resource.field]
  if (ceiling == null || projection == null || projection.mode === 'unavailable') return null
  if (!ceiling.allowedModes.includes(projection.mode)) return null
  if (ceiling.maxPrecision != null) {
    const rank = ['redacted', 'coarse', 'exact']
    if (rank.indexOf(projection.precision) > rank.indexOf(ceiling.maxPrecision)) return null
  }
  return { fields: [input.resource.field], maxPrecision: projection.precision, modes: [projection.mode] }
}

const processConstraints = (input: MaterializationInputV1, name: BuiltInCapabilityNameV1) => {
  const policy = input.policy.process
  if (policy.access !== 'sandboxed') return null
  const executableId = input.resource.kind === 'processExecutable'
    ? input.resource.invocation === 'program'
      ? input.resource.executableId
      : input.resource.shellExecutableId
    : undefined
  if (executableId != null && !policy.executables.some(item => item.executableId === executableId)) return null
  if (
    name === 'host.process.shell' &&
    (policy.shell.access !== 'restricted' || executableId !== policy.shell.executableId)
  ) return null
  if (name === 'host.process.network') {
    if (policy.network.access !== 'restricted' || input.resource.kind !== 'processNetworkEndpoint') return null
    const resource = input.resource
    const endpoint = policy.network.endpoints.find(item =>
      item.hostname === resource.hostname && item.transport === resource.transport &&
      item.ports.includes(resource.port)
    )
    if (endpoint == null) return null
    return {
      endpoints: [{
        hostname: endpoint.hostname,
        ports: [resource.port],
        transport: endpoint.transport
      }],
      maxSockets: policy.network.maxSockets,
      privateNetwork: policy.network.privateNetwork
    } as unknown as Readonly<Record<string, JsonValueV1>>
  }
  if (name === 'host.process.execute') {
    return {
      executableIds: executableId == null ? policy.executables.map(item => item.executableId) : [executableId],
      limits: policy.limits,
      rootIds: policy.mounts.map(item => item.rootId)
    } as unknown as Readonly<Record<string, JsonValueV1>>
  }
  if (name === 'host.process.shell') {
    return { executableIds: executableId == null ? [] : [executableId] }
  }
  if (name === 'host.process.signal') {
    return { signals: ['SIGINT', 'SIGKILL', 'SIGTERM'] }
  }
  return null
}

export const materializeCapabilityConstraintsV1 = (
  input: MaterializationInputV1,
  name: BuiltInCapabilityNameV1,
  available: boolean
): Readonly<Record<string, JsonValueV1>> | null => {
  if (name === 'host.fs') return fsConstraints(input, available)
  if (name === 'host.network.http' || name === 'host.network.mock') {
    return networkConstraints(input, name, available)
  }
  if (name.startsWith('host.device.')) return deviceConstraints(input)
  if (name.startsWith('host.system.')) return systemConstraints(input)
  if (name.startsWith('host.process.')) return processConstraints(input, name)
  return null
}
