import { allOf, operation } from '@holonomyjs/runtime/kernel/operation-types'
import type { OperationDescriptorV1 } from '@holonomyjs/runtime/kernel/operation-types'
import type { StorageOperationV1 } from './storage-types.js'

const row = (
  member: string,
  operationId: StorageOperationV1,
  argsSchemaId: string,
  resultSchemaId: string,
  resourceSchemaId: string,
  kind: OperationDescriptorV1['kind']
) =>
  operation({
    argsSchemaId,
    capability: allOf('storage', 'host.storage'),
    deliverySchemaId: 'PromiseResultDeliveryV1',
    interception: 'host',
    kind,
    limitsOwner: 'StorageSandboxV2.limits',
    member,
    modes: ['promise'],
    module: 'holo:storage',
    operation: operationId,
    resourceSchemaId,
    resultSchemaId
  })

export const STORAGE_OPERATION_REGISTRY_V1: readonly OperationDescriptorV1[] = Object.freeze([
  row('kv.get', 'storage.kv.get', 'StorageKvKeyArgsV1', 'StorageKvGetResultV1', 'StorageKvResourceV1', 'read'),
  row('kv.set', 'storage.kv.set', 'StorageKvSetArgsV1', 'StorageVoidResultV1', 'StorageKvResourceV1', 'write'),
  row('kv.delete', 'storage.kv.delete', 'StorageKvKeyArgsV1', 'boolean', 'StorageKvResourceV1', 'write'),
  row('kv.list', 'storage.kv.list', 'StorageKvListArgsV1', 'StorageKvListResultV1', 'StorageKvResourceV1', 'read'),
  row(
    'sqlite.execute',
    'storage.sqlite.execute',
    'StorageSqlStatementArgsV1',
    'StorageExecuteResultV1',
    'StorageSqlResourceV1',
    'write'
  ),
  row(
    'sqlite.query',
    'storage.sqlite.query',
    'StorageSqlStatementArgsV1',
    'StorageQueryResultV1',
    'StorageSqlResourceV1',
    'read'
  ),
  row(
    'sqlite.transaction',
    'storage.sqlite.transaction',
    'StorageSqlTransactionArgsV1',
    'StorageTransactionResultV1',
    'StorageSqlResourceV1',
    'write'
  )
])
