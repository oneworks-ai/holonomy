import { FACADE_DELIVERY_REGISTRY_V1 } from './facade-delivery.js'
import { allOf, inheritedCapability, operation } from './operation-types.js'
import type { OperationDescriptorV1 } from './operation-types.js'
import { PROCESS_INHERITED_ROWS_V1 } from './process-registry-rows.js'

export type ProcessOperationV1 =
  | 'process.network.connect'
  | 'process.program.spawn'
  | 'process.resource.close'
  | 'process.shell.spawn'
  | 'process.signal.send'
  | 'process.stdin.end'
  | 'process.stdin.write'
  | 'process.stdio.destroy'
  | 'process.stdio.pause'
  | 'process.stdio.resume'
  | 'process.wait'

const spawn = (
  member: string,
  operationId: 'process.program.spawn' | 'process.shell.spawn',
  argsSchemaId: string,
  resultSchemaId: string,
  deliverySchemaId: string
): OperationDescriptorV1 =>
  operation({
    argsSchemaId,
    capability: operationId === 'process.shell.spawn'
      ? allOf('shell-spawn', 'host.process.execute', 'host.process.shell')
      : allOf('program-spawn', 'host.process.execute'),
    deliverySchemaId,
    interception: 'host',
    kind: member.endsWith('Sync') ? 'invoke' : 'open',
    limitsOwner: 'ProcessLimitsV2',
    member,
    modes: [member.endsWith('Sync') ? 'sync' : member.startsWith('exec') ? 'callback' : 'sync'],
    module: 'node:child_process',
    operation: operationId,
    resourceSchemaId: 'ProcessExecutableResourceV1→ProcessInstanceResourceV1',
    resultSchemaId
  })

export const PROCESS_OPERATION_REGISTRY_V1: readonly OperationDescriptorV1[] = Object.freeze([
  operation({
    argsSchemaId: 'ProcessNetworkAuthorizationArgsV1',
    capability: allOf('process-network-connect', 'host.process.network'),
    deliverySchemaId: 'PromiseResultDeliveryV1',
    interception: 'host',
    kind: 'open',
    limitsOwner: 'ProcessNetworkCapabilityConstraintsV1',
    member: 'authorizeProcessNetwork',
    modes: ['promise'],
    module: 'holo:runtime',
    operation: 'process.network.connect',
    resourceSchemaId: 'ProcessNetworkEndpointResourceV1',
    resultSchemaId: 'ProcessNetworkAuthorizationReceiptV1'
  }),
  spawn(
    'spawn',
    'process.program.spawn',
    'ProcessProgramSpawnArgsV1',
    'ChildProcessFacadeV1',
    'ProcessSyncDeliveryV1'
  ),
  spawn(
    'spawnShell',
    'process.shell.spawn',
    'ProcessShellSpawnArgsV1',
    'ChildProcessFacadeV1',
    'ProcessSyncDeliveryV1'
  ),
  spawn(
    'execFile',
    'process.program.spawn',
    'ProcessExecFileArgsV1',
    'ChildProcessFacadeV1',
    'ProcessExecDeliveryV1'
  ),
  spawn(
    'exec',
    'process.shell.spawn',
    'ProcessExecArgsV1',
    'ChildProcessFacadeV1',
    'ProcessExecDeliveryV1'
  ),
  spawn(
    'spawnSync',
    'process.program.spawn',
    'ProcessProgramSpawnArgsV1',
    'ProcessSyncResultV1',
    'ProcessSyncDeliveryV1'
  ),
  spawn(
    'execFileSync',
    'process.program.spawn',
    'ProcessExecFileArgsV1',
    'ProcessSyncOutputV1',
    'ProcessSyncDeliveryV1'
  ),
  spawn(
    'execSync',
    'process.shell.spawn',
    'ProcessExecArgsV1',
    'ProcessSyncOutputV1',
    'ProcessSyncDeliveryV1'
  ),
  operation({
    argsSchemaId: 'ProcessSignalV1',
    capability: allOf('process-signal', 'host.process.signal'),
    deliverySchemaId: 'ProcessSyncDeliveryV1',
    interception: 'host',
    kind: 'invoke',
    limitsOwner: 'ProcessSignalCapabilityConstraintsV1',
    member: 'ChildProcess.kill',
    modes: ['sync'],
    module: 'node:child_process',
    operation: 'process.signal.send',
    resourceSchemaId: 'ProcessInstanceResourceV1',
    resultSchemaId: 'boolean'
  }),
  ...PROCESS_INHERITED_ROWS_V1.map((
    [member, operationId, kind, interception, argsSchemaId, resultSchemaId, deliverySchemaId, limitsOwner]
  ) =>
    operation({
      argsSchemaId,
      capability: inheritedCapability,
      deliverySchemaId,
      interception,
      kind,
      limitsOwner,
      member,
      modes: FACADE_DELIVERY_REGISTRY_V1[deliverySchemaId]?.kind === 'invocation'
        ? FACADE_DELIVERY_REGISTRY_V1[deliverySchemaId].invocationModes
        : [],
      module: 'node:child_process',
      operation: operationId,
      resourceSchemaId: 'ProcessInstanceResourceV1',
      resultSchemaId
    })
  )
])
