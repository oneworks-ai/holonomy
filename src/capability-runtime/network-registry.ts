import { anyOf, inheritedCapability, operation, unavailableCapability } from './operation-types.js'
import type { OperationDescriptorV1 } from './operation-types.js'

export type NetworkOperationV1 =
  | 'network.fetch.redirect'
  | 'network.fetch.request'
  | 'network.response.body.read'
  | 'network.response.metadata.read'
  | 'network.websocket.connect'

const inherited = (
  member: string,
  operationId: NetworkOperationV1,
  modes: readonly ('promise' | 'sync')[],
  resultSchemaId: string
) =>
  operation({
    argsSchemaId: 'EmptyArgsV1',
    capability: inheritedCapability,
    deliverySchemaId: modes[0] === 'sync' ? 'SyncResultDeliveryV1' : 'PromiseResultDeliveryV1',
    interception: 'systemOnly',
    kind: operationId === 'network.response.metadata.read' ? 'read' : 'invoke',
    limitsOwner: 'NetworkSandboxV2.limits',
    member,
    modes,
    module: 'web:fetch',
    operation: operationId,
    resourceSchemaId: 'NetworkResponseBodyBindingV1',
    resultSchemaId
  })

export const NETWORK_OPERATION_REGISTRY_V1: readonly OperationDescriptorV1[] = Object.freeze([
  operation({
    argsSchemaId: 'NetworkInvocationSnapshotV1',
    capability: anyOf(
      ['mock', 'host.network.mock'],
      ['real', 'host.network.http']
    ),
    deliverySchemaId: 'PromiseResultDeliveryV1',
    interception: 'host',
    kind: 'invoke',
    limitsOwner: 'NetworkSandboxV2',
    member: 'fetch',
    modes: ['promise'],
    module: 'web:fetch',
    operation: 'network.fetch.request',
    resourceSchemaId: 'NetworkResourceV1',
    resultSchemaId: 'ResponseV1'
  }),
  operation({
    argsSchemaId: 'NetworkRedirectInvocationV1',
    capability: inheritedCapability,
    deliverySchemaId: 'PromiseVoidDeliveryV1',
    interception: 'host',
    kind: 'invoke',
    limitsOwner: 'NetworkSandboxV2.limits.maxRedirects',
    member: 'followRedirect',
    modes: ['promise'],
    module: 'web:fetch',
    operation: 'network.fetch.redirect',
    resourceSchemaId: 'NetworkResourceV1',
    resultSchemaId: 'void'
  }),
  inherited('Response.metadata', 'network.response.metadata.read', ['sync'], 'NetworkResponseMetadataV1'),
  inherited('Response.text', 'network.response.body.read', ['promise'], 'string'),
  inherited('Response.json', 'network.response.body.read', ['promise'], 'JsonValueV1'),
  inherited('Response.arrayBuffer', 'network.response.body.read', ['promise'], 'ArrayBuffer'),
  inherited('Response.bytes', 'network.response.body.read', ['promise'], 'Uint8Array'),
  inherited('Response.clone', 'network.response.body.read', ['sync'], 'ResponseV1'),
  operation({
    argsSchemaId: 'NetworkWebSocketArgsV1',
    capability: unavailableCapability,
    deliverySchemaId: 'SyncNeverDeliveryV1',
    interception: 'host',
    kind: 'open',
    limitsOwner: 'SandboxPolicyV2',
    member: 'WebSocket',
    modes: ['sync'],
    module: 'web:socket',
    operation: 'network.websocket.connect',
    resourceSchemaId: 'NetworkResourceV1',
    resultSchemaId: 'never'
  })
])
