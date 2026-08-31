import { allOf, operation } from '@holonomyjs/runtime/kernel/operation-types'
import type { BuiltInCapabilityNameV1, OperationDescriptorV1 } from '@holonomyjs/runtime/kernel/operation-types'
import type { SystemInformationFieldV1 } from '@holonomyjs/runtime/kernel/registry-types'

type Row = readonly [
  member: string,
  field: SystemInformationFieldV1,
  operation: string,
  capability: BuiltInCapabilityNameV1,
  unavailable: string
]

const ROWS = [
  ['arch', 'os.arch', 'system.os.arch.read', 'host.system.basic', 'throw'],
  ['machine', 'os.machine', 'system.os.machine.read', 'host.system.version', 'throw'],
  ['platform', 'os.platform', 'system.os.platform.read', 'host.system.basic', 'throw'],
  ['type', 'os.type', 'system.os.type.read', 'host.system.basic', 'throw'],
  ['release', 'os.release', 'system.os.release.read', 'host.system.version', 'throw'],
  ['version', 'os.version', 'system.os.version.read', 'host.system.version', 'throw'],
  ['cpus', 'os.cpus', 'system.os.cpus.read', 'host.system.compute', 'throw'],
  ['availableParallelism', 'os.availableParallelism', 'system.os.parallelism.read', 'host.system.compute', 'throw'],
  ['totalmem', 'os.totalmem', 'system.os.memory.total.read', 'host.system.memory', 'throw'],
  ['freemem', 'os.freemem', 'system.os.memory.free.read', 'host.system.memory', 'throw'],
  ['uptime', 'os.uptime', 'system.os.uptime.read', 'host.system.runtime', 'throw'],
  ['loadavg', 'os.loadavg', 'system.os.loadavg.read', 'host.system.runtime', 'throw'],
  ['hostname', 'os.hostname', 'system.os.hostname.read', 'host.system.identity', 'throw'],
  [
    'networkInterfaces',
    'os.networkInterfaces',
    'system.os.network-interfaces.read',
    'host.system.network-topology',
    'emptyObject'
  ],
  ['userInfo', 'os.userInfo', 'system.os.user-info.read', 'host.system.identity', 'throw'],
  ['homedir', 'os.homedir', 'system.os.home-directory.read', 'host.system.identity', 'throw'],
  ['tmpdir', 'os.tmpdir', 'system.os.temp-directory.read', 'host.system.identity', 'throw'],
  ['pid', 'process.pid', 'system.process.pid.read', 'host.system.process-identity', 'throwOnRead'],
  ['cwd', 'process.cwd', 'system.process.cwd.read', 'host.system.process-identity', 'throwOnInvoke'],
  ['execPath', 'process.execPath', 'system.process.exec-path.read', 'host.system.process-identity', 'throwOnRead'],
  ['env', 'process.env', 'system.process.environment.read', 'host.system.process-identity', 'emptyObject']
] as const satisfies readonly Row[]

export const SYSTEM_OPERATION_REGISTRY_V1: readonly OperationDescriptorV1[] = Object.freeze(
  ROWS.map(([member, field, operationId, capability, unavailable]) =>
    operation({
      argsSchemaId: member === 'userInfo' ? 'SystemUserInfoArgsV1' : 'EmptyArgsV1',
      capability: allOf(capability, capability),
      deliverySchemaId: 'SystemSyncDeliveryV1',
      interception: 'host',
      kind: 'read',
      limitsOwner: `SystemFieldValueMapV1.${field}:${unavailable}`,
      member,
      modes: ['sync'],
      module: field.startsWith('os.') ? 'node:os' : 'node:process',
      operation: operationId,
      resourceSchemaId: 'SystemInformationFieldResourceV1',
      resultSchemaId: `SystemFieldValueMapV1.${field}`
    })
  )
)
