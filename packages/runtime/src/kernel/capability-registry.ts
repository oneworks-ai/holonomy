import type { CapabilityDefinitionDescriptorV1 } from './capability-types.js'
import type { BuiltInCapabilityNameV1 } from './operation-types.js'

type Definition = readonly [
  name: BuiltInCapabilityNameV1,
  constraintKind: CapabilityDefinitionDescriptorV1['constraintKind'],
  constraintSchemaId: string,
  providerModule: string
]

const DEFINITIONS: readonly Definition[] = [
  ['host.device.sensitive', 'device', 'DeviceCapabilityConstraintsV1', 'host.device'],
  ['host.device.state', 'device', 'DeviceCapabilityConstraintsV1', 'host.device'],
  ['host.device.summary', 'device', 'DeviceCapabilityConstraintsV1', 'host.device'],
  ['host.diagnostics.source.read', 'numericReader', 'ReaderCapabilityConstraintsV1', 'host.diagnostics'],
  ['host.fs', 'filesystem', 'FsCapabilityConstraintsV1', 'host.fs'],
  ['host.network.http', 'network', 'NetworkCapabilityConstraintsV1', 'host.network'],
  ['host.network.mock', 'network', 'NetworkCapabilityConstraintsV1', 'host.network.mock'],
  ['host.network.request-body.read', 'numericReader', 'ReaderCapabilityConstraintsV1', 'host.network'],
  ['host.process.execute', 'process', 'ProcessExecutionCapabilityConstraintsV1', 'host.process'],
  ['host.process.network', 'process', 'ProcessNetworkCapabilityConstraintsV1', 'host.process'],
  ['host.process.shell', 'process', 'ProcessShellCapabilityConstraintsV1', 'host.process'],
  ['host.process.signal', 'process', 'ProcessSignalCapabilityConstraintsV1', 'host.process'],
  ['host.storage.credential', 'credential', 'CredentialCapabilityConstraintsV1', 'host.storage'],
  ['host.system.basic', 'system', 'SystemCapabilityConstraintsV1', 'host.system'],
  ['host.system.compute', 'system', 'SystemCapabilityConstraintsV1', 'host.system'],
  ['host.system.identity', 'system', 'SystemCapabilityConstraintsV1', 'host.system'],
  ['host.system.memory', 'system', 'SystemCapabilityConstraintsV1', 'host.system'],
  ['host.system.network-topology', 'system', 'SystemCapabilityConstraintsV1', 'host.system'],
  ['host.system.process-identity', 'system', 'SystemCapabilityConstraintsV1', 'host.system'],
  ['host.system.runtime', 'system', 'SystemCapabilityConstraintsV1', 'host.system'],
  ['host.system.version', 'system', 'SystemCapabilityConstraintsV1', 'host.system']
]

export const CAPABILITY_DEFINITION_REGISTRY_V1: readonly CapabilityDefinitionDescriptorV1[] = Object.freeze(
  DEFINITIONS.map(([name, constraintKind, constraintSchemaId, providerModule]) =>
    Object.freeze({ constraintKind, constraintSchemaId, name, providerModule, version: 1 as const })
  )
)

export const CAPABILITY_DEFINITION_BY_NAME_V1 = new Map(
  CAPABILITY_DEFINITION_REGISTRY_V1.map(item => [item.name, item])
)
