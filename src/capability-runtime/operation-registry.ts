import { DEVICE_OPERATION_REGISTRY_V1 } from './device-registry.js'
import { FILESYSTEM_OPERATION_REGISTRY_V1 } from './filesystem-registry.js'
import { NETWORK_OPERATION_REGISTRY_V1 } from './network-registry.js'
import type { OperationDescriptorV1 } from './operation-types.js'
import { PROCESS_OPERATION_REGISTRY_V1 } from './process-registry.js'
import { SYSTEM_OPERATION_REGISTRY_V1 } from './system-registry.js'

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
