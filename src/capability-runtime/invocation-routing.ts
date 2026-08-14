import {
  canonicalizeProcessNetworkEndpointResource,
  canonicalizeProgramExecutableResource,
  canonicalizeShellExecutableResource
} from './canonical-process-resources.js'
import {
  canonicalizeDeviceFieldResource,
  canonicalizeFilesystemResource,
  canonicalizeSystemInformationFieldResource
} from './canonical-resources.js'
import { CapabilityInvocationError } from './errors.js'
import { invocationJsonDigestV1 } from './json-invocation-value.js'
import type { JsonValueV1 } from './json-types.js'
import { buildNetworkInvocationSnapshotV1 } from './network-invocation-builder.js'
import { normalizeNetworkInvocationSnapshotV1 } from './network-invocation.js'
import { DEVICE_OPERATION_PRIVACY_TIER_V1 } from './registry-types.js'

const SYSTEM_MEMBER_FIELDS = Object.freeze(
  {
    arch: 'os.arch',
    availableParallelism: 'os.availableParallelism',
    cpus: 'os.cpus',
    cwd: 'process.cwd',
    env: 'process.env',
    execPath: 'process.execPath',
    freemem: 'os.freemem',
    homedir: 'os.homedir',
    hostname: 'os.hostname',
    loadavg: 'os.loadavg',
    machine: 'os.machine',
    networkInterfaces: 'os.networkInterfaces',
    pid: 'process.pid',
    platform: 'os.platform',
    release: 'os.release',
    tmpdir: 'os.tmpdir',
    totalmem: 'os.totalmem',
    type: 'os.type',
    uptime: 'os.uptime',
    userInfo: 'os.userInfo',
    version: 'os.version'
  } as const
)

const DEVICE_MEMBER_OPERATIONS = Object.freeze(
  {
    getCellularState: 'device.connectivity.cellular.state.read',
    getConnectivity: 'device.connectivity.read',
    getDisplay: 'device.display.read',
    getFormFactor: 'device.form-factor.read',
    getInput: 'device.input.read',
    getLifecycle: 'device.lifecycle.read',
    getMediaCapabilities: 'device.media.capabilities.read',
    getPower: 'device.power.read',
    getSecurityCapabilities: 'device.security.capabilities.read',
    getSensorCapabilities: 'device.sensor.capabilities.read',
    getSummary: 'device.summary.read',
    getThermal: 'device.thermal.read',
    getWifiIdentity: 'device.connectivity.wifi.identity.read',
    getWifiState: 'device.connectivity.wifi.state.read',
    subscribe: 'device.events.subscribe'
  } as const
)

export const routeCapabilityInvocationV1 = (input: {
  arguments?: JsonValueV1
  generation: number
  member: string
  method?: unknown
  module: string
  networkProvider: 'host.network' | 'host.network.mock'
  requestOrdinal: number
  url?: unknown
  path?: unknown
}) => {
  if (input.module === 'web:fetch' && input.member === 'fetch') {
    const snapshot = input.arguments == null
      ? (() => {
        if (typeof input.url !== 'string' || typeof input.method !== 'string') {
          throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
        }
        return buildNetworkInvocationSnapshotV1({
          hop: 0,
          label: input.url,
          logicalRequestId: `fetch-${input.generation}-${input.requestOrdinal}`,
          method: input.method,
          url: input.url
        })
      })()
      : normalizeNetworkInvocationSnapshotV1(input.arguments)
    return { argumentsValue: snapshot, preferredProviderModule: input.networkProvider, resource: snapshot.resource }
  }
  if (input.module === 'node:fs' || input.module === 'node:fs/promises') {
    return {
      preferredProviderModule: 'host.fs',
      resource: canonicalizeFilesystemResource(input.path, String(input.path).slice(0, 256))
    }
  }
  if (input.module === 'node:child_process') {
    const args = input.arguments
    if (args == null || typeof args !== 'object' || Array.isArray(args)) {
      throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
    }
    const source = args as Readonly<Record<string, JsonValueV1>>
    const options = source.options != null && typeof source.options === 'object' && !Array.isArray(source.options)
      ? source.options as Readonly<Record<string, JsonValueV1>>
      : {}
    const shared = {
      cwdSemanticResourceDigest: options.cwd == null
        ? undefined
        : canonicalizeFilesystemResource(options.cwd, 'process cwd').semanticResourceDigest,
      environmentNamesDigest: invocationJsonDigestV1(
        options.env == null || typeof options.env !== 'object' || Array.isArray(options.env)
          ? []
          : Object.keys(options.env).sort()
      ),
      environmentScope: source.environmentScope,
      stdioDigest: invocationJsonDigestV1(options.stdio ?? ['pipe', 'pipe', 'pipe'])
    }
    if (input.member === 'exec' || input.member === 'execSync' || input.member === 'spawnShell') {
      return {
        preferredProviderModule: 'host.process',
        resource: canonicalizeShellExecutableResource({
          ...shared,
          commandDigest: invocationJsonDigestV1(source.command ?? null),
          label: String(source.command ?? '').slice(0, 256),
          shellExecutableId: options.shellExecutableId
        })
      }
    }
    return {
      preferredProviderModule: 'host.process',
      resource: canonicalizeProgramExecutableResource({
        ...shared,
        argvDigest: invocationJsonDigestV1(source.args ?? []),
        executableId: source.executableId,
        label: String(source.executableId ?? '').slice(0, 256)
      })
    }
  }
  if (input.module === 'holo:runtime' && input.member === 'authorizeProcessNetwork') {
    const args = input.arguments
    if (args == null || typeof args !== 'object' || Array.isArray(args)) {
      throw new CapabilityInvocationError('argument.invalid', 'process.network.connect')
    }
    const endpoint = args as Readonly<Record<string, JsonValueV1>>
    return {
      preferredProviderModule: 'host.process',
      resource: canonicalizeProcessNetworkEndpointResource({
        hostname: endpoint.hostname,
        label: `${String(endpoint.transport)}://${String(endpoint.hostname)}:${String(endpoint.port)}`,
        port: endpoint.port,
        transport: endpoint.transport
      })
    }
  }
  if (input.module === 'node:os' || input.module === 'node:process') {
    const field = SYSTEM_MEMBER_FIELDS[input.member as keyof typeof SYSTEM_MEMBER_FIELDS]
    if (field == null) throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
    return {
      preferredProviderModule: 'host.system',
      resource: canonicalizeSystemInformationFieldResource(field, field)
    }
  }
  if (input.module === 'holo:device' || input.module === 'holo:device/promises') {
    const operation = DEVICE_MEMBER_OPERATIONS[input.member as keyof typeof DEVICE_MEMBER_OPERATIONS]
    if (operation == null) throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
    const resource = canonicalizeDeviceFieldResource(
      operation,
      operation === 'device.events.subscribe' ? 'events' : operation.slice('device.'.length, -'.read'.length),
      DEVICE_OPERATION_PRIVACY_TIER_V1[operation],
      operation
    )
    return {
      preferredProviderModule: 'host.device',
      resource
    }
  }
  throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
}
