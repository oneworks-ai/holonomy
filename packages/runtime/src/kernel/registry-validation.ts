import type { FilesystemOperationV1 } from '@holonomyjs/capability-fs/kernel/filesystem-registry'
import type { NetworkOperationV1 } from '@holonomyjs/capability-network/kernel/network-registry'
import type { ProcessOperationV1 } from '@holonomyjs/capability-process/kernel/process-registry'
import { SYSTEM_OPERATION_REGISTRY_V1 } from '@holonomyjs/capability-system/kernel/system-registry'
import { FACADE_DELIVERY_REGISTRY_V1 } from './facade-delivery.js'
import { OPERATION_REGISTRY_V1 } from './operation-registry.js'
import type { InvocationModeV1, OperationDescriptorV1 } from './operation-types.js'
import { operationSchemaOwnerV1 } from './registry-schema-ids.js'
import { DEVICE_OPERATIONS_V1 } from './registry-types.js'

const FS_OPERATIONS = [
  'filesystem.directory.create',
  'filesystem.directory.read',
  'filesystem.entry.rename',
  'filesystem.entry.unlink',
  'filesystem.file.close',
  'filesystem.file.open',
  'filesystem.file.read',
  'filesystem.file.write',
  'filesystem.metadata.lstat',
  'filesystem.metadata.stat',
  'filesystem.watch.close',
  'filesystem.watch.subscribe'
] as const satisfies readonly FilesystemOperationV1[]
const NETWORK_OPERATIONS = [
  'network.fetch.redirect',
  'network.fetch.request',
  'network.response.body.read',
  'network.response.metadata.read',
  'network.websocket.connect'
] as const satisfies readonly NetworkOperationV1[]
const PROCESS_OPERATIONS = [
  'process.network.connect',
  'process.program.spawn',
  'process.resource.close',
  'process.shell.spawn',
  'process.signal.send',
  'process.stdin.end',
  'process.stdin.write',
  'process.stdio.destroy',
  'process.stdio.pause',
  'process.stdio.resume',
  'process.wait'
] as const satisfies readonly ProcessOperationV1[]

const assertCovered = (name: string, operations: readonly string[], rows: readonly { operation: string }[]) => {
  for (const operation of operations) {
    if (!rows.some(row => row.operation === operation)) throw new Error(`${name} missing ${operation}`)
  }
}

const assertSchemaRole = (
  row: OperationDescriptorV1,
  role: 'args' | 'delivery' | 'resource' | 'result',
  schemaId: string
) => {
  const owner = operationSchemaOwnerV1(schemaId)
  if (owner == null) {
    throw new Error(`Registry row ${row.module}/${row.member} has unowned schema ${schemaId}`)
  }
  if (!owner.roles.includes(role)) {
    throw new Error(`Registry row ${row.module}/${row.member} has invalid ${role} schema role ${schemaId}`)
  }
}

const assertReferenceRole = (schemaId: string, role: 'event' | 'result' | 'tuple') => {
  const owner = operationSchemaOwnerV1(schemaId)
  if (owner == null || !owner.roles.includes(role)) {
    throw new Error(`Delivery has unowned ${role} schema ${schemaId}`)
  }
}

const sameModes = (left: readonly InvocationModeV1[], right: readonly InvocationModeV1[]): boolean =>
  left.length === right.length && left.every((mode, index) => mode === right[index])

const assertDelivery = (row: OperationDescriptorV1) => {
  const delivery = FACADE_DELIVERY_REGISTRY_V1[row.deliverySchemaId]
  if (delivery == null) throw new Error(`Registry row ${row.module}/${row.member} has unknown delivery`)
  if (delivery.kind === 'resourceEvents') {
    if (row.modes.length !== 0) throw new Error(`Registry row ${row.member} delivery mode drift`)
    assertReferenceRole(delivery.eventSchemaId, 'event')
    return
  }
  if (!sameModes(delivery.invocationModes, row.modes)) {
    throw new Error(`Registry row ${row.member} delivery invocation mode drift`)
  }
  if (delivery.callback != null) {
    if (!row.modes.includes('callback')) throw new Error(`Registry row ${row.member} callback delivery mode drift`)
    const { failure, success } = delivery.callback
    if (success.kind === 'variants') {
      for (const variant of success.variants) {
        assertSchemaRole(row, 'args', variant.whenArgumentsSchemaId)
        if (variant.delivery.kind === 'result') {
          assertReferenceRole(variant.delivery.resultSchemaId, 'result')
        }
        if (variant.delivery.kind === 'tuple') {
          assertReferenceRole(variant.delivery.tupleSchemaId, 'tuple')
        }
      }
    } else if (success.kind === 'result' && success.resultSchemaId !== '$operation.resultSchemaId') {
      assertReferenceRole(success.resultSchemaId, 'result')
    }
    if (success.kind === 'tuple') assertReferenceRole(success.tupleSchemaId, 'tuple')
    if (failure.kind === 'errorAndTuple') assertReferenceRole(failure.tupleSchemaId, 'tuple')
  }
  if (delivery.immediateResultSchemaId != null) {
    assertReferenceRole(delivery.immediateResultSchemaId, 'result')
  }
  if (delivery.resourceEvents != null) assertReferenceRole(delivery.resourceEvents.eventSchemaId, 'event')
}

const assertResultVariants = (row: OperationDescriptorV1) => {
  const variants = row.resultVariants
  if (variants == null) {
    if (row.deliverySchemaId.endsWith('VariantDeliveryV1')) {
      throw new Error(`Registry row ${row.member} has variant delivery without result variants`)
    }
    return
  }
  const argumentIds = new Set<string>()
  for (const variant of variants) {
    assertSchemaRole(row, 'args', variant.whenArgumentsSchemaId)
    assertSchemaRole(row, 'result', variant.resultSchemaId)
    if (argumentIds.has(variant.whenArgumentsSchemaId)) {
      throw new Error(`Registry row ${row.member} has duplicate result variant`)
    }
    argumentIds.add(variant.whenArgumentsSchemaId)
  }
  const delivery = FACADE_DELIVERY_REGISTRY_V1[row.deliverySchemaId]
  if (delivery?.kind !== 'invocation' || !row.modes.includes('callback')) return
  const success = delivery.callback?.success
  if (success?.kind !== 'variants') {
    throw new Error(`Registry row ${row.member} callback result variants are missing`)
  }
  const expected = variants.map(variant => `${variant.whenArgumentsSchemaId}:${variant.resultSchemaId}`).sort()
  const actual = success.variants.map(variant => {
    const result = variant.delivery.kind === 'void'
      ? 'void'
      : variant.delivery.kind === 'result'
      ? variant.delivery.resultSchemaId
      : variant.delivery.tupleSchemaId
    return `${variant.whenArgumentsSchemaId}:${result}`
  }).sort()
  if (expected.join('|') !== actual.join('|')) {
    throw new Error(`Registry row ${row.member} callback result variant drift`)
  }
}

export const validateOperationRegistryV1 = (
  registry: readonly OperationDescriptorV1[] = OPERATION_REGISTRY_V1
): void => {
  assertCovered('Device Registry', DEVICE_OPERATIONS_V1, registry)
  assertCovered('Filesystem Registry', FS_OPERATIONS, registry)
  assertCovered('Network Registry', NETWORK_OPERATIONS, registry)
  assertCovered('Process Registry', PROCESS_OPERATIONS, registry)
  for (const system of SYSTEM_OPERATION_REGISTRY_V1) {
    if (!registry.some(row => row.module === system.module && row.member === system.member)) {
      throw new Error(`System Registry missing ${system.module}/${system.member}`)
    }
  }
  for (const row of registry) {
    assertSchemaRole(row, 'args', row.argsSchemaId)
    assertSchemaRole(row, 'delivery', row.deliverySchemaId)
    assertSchemaRole(row, 'resource', row.resourceSchemaId)
    assertSchemaRole(row, 'result', row.resultSchemaId)
    assertDelivery(row)
    assertResultVariants(row)
    if (
      row.interception === 'systemOnly' &&
      (!('kind' in row.capability) || row.capability.kind !== 'inherited')
    ) {
      throw new Error(`systemOnly Registry row ${row.operation} must inherit its binding`)
    }
    if ('anyOf' in row.capability && row.capability.anyOf.length === 0) {
      throw new Error(`Registry row ${row.operation} has an empty capability requirement`)
    }
  }
}
