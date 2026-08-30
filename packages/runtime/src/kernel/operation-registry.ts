import { DEVICE_OPERATION_REGISTRY_V1 } from '@holonomyjs/capability-device/kernel/device-registry'
import { FILESYSTEM_OPERATION_REGISTRY_V1 } from '@holonomyjs/capability-fs/kernel/filesystem-registry'
import { NETWORK_OPERATION_REGISTRY_V1 } from '@holonomyjs/capability-network/kernel/network-registry'
import { PROCESS_OPERATION_REGISTRY_V1 } from '@holonomyjs/capability-process/kernel/process-registry'
import { SYSTEM_OPERATION_REGISTRY_V1 } from '@holonomyjs/capability-system/kernel/system-registry'
import type { OperationDescriptorV1 } from './operation-types.js'

export const OPERATION_REGISTRY_V1: readonly OperationDescriptorV1[] = Object.freeze([
  ...DEVICE_OPERATION_REGISTRY_V1,
  ...FILESYSTEM_OPERATION_REGISTRY_V1,
  ...NETWORK_OPERATION_REGISTRY_V1,
  ...PROCESS_OPERATION_REGISTRY_V1,
  ...SYSTEM_OPERATION_REGISTRY_V1
])

export const operationsByModule = (): Readonly<Record<string, readonly OperationDescriptorV1[]>> => {
  const output: Record<string, OperationDescriptorV1[]> = Object.create(null)
  for (const descriptor of OPERATION_REGISTRY_V1) {
    ;(output[descriptor.module] ??= []).push(descriptor)
  }
  for (const descriptors of Object.values(output)) Object.freeze(descriptors)
  return Object.freeze(output)
}
