import { allOf, dynamicCapability, operation } from '@holonomyjs/runtime/kernel/operation-types'
import type {
  BuiltInCapabilityNameV1,
  InvocationModeV1,
  OperationDescriptorV1
} from '@holonomyjs/runtime/kernel/operation-types'
import { DEVICE_OPERATIONS_V1 } from '@holonomyjs/runtime/kernel/registry-types'
import type { DeviceOperationV1 } from '@holonomyjs/runtime/kernel/registry-types'

const capabilityFor = (operationId: DeviceOperationV1): BuiltInCapabilityNameV1 =>
  operationId === 'device.connectivity.wifi.identity.read'
    ? 'host.device.sensitive'
    : operationId === 'device.summary.read' || operationId === 'device.form-factor.read' ||
        ['device.power.read', 'device.display.read', 'device.input.read', 'device.lifecycle.read'].includes(operationId)
    ? 'host.device.summary'
    : 'host.device.state'

const memberFor = (operationId: DeviceOperationV1): string => {
  if (operationId === 'device.connectivity.cellular.state.read') return 'getCellularState'
  if (operationId === 'device.connectivity.wifi.identity.read') return 'getWifiIdentity'
  if (operationId === 'device.connectivity.wifi.state.read') return 'getWifiState'
  const suffix = operationId.slice('device.'.length).replace(/\.read$/u, '')
  return `get${suffix.split(/[.-]/u).map(value => value[0]!.toUpperCase() + value.slice(1)).join('')}`
}

const descriptor = (
  operationId: DeviceOperationV1,
  module: 'holo:device' | 'holo:device/promises',
  modes: readonly InvocationModeV1[]
): OperationDescriptorV1 =>
  operation({
    argsSchemaId: operationId === 'device.events.subscribe' ? 'DeviceSubscriptionOptionsV1' : 'EmptyArgsV1',
    capability: operationId === 'device.events.subscribe'
      ? dynamicCapability('DeviceEventKindsCapabilityRequirementV1')
      : allOf(capabilityFor(operationId), capabilityFor(operationId)),
    deliverySchemaId: operationId === 'device.events.subscribe'
      ? 'DeviceSubscriptionDeliveryV1'
      : modes[0] === 'sync'
      ? 'SyncResultDeliveryV1'
      : 'PromiseResultDeliveryV1',
    interception: 'host',
    kind: operationId === 'device.events.subscribe' ? 'subscribe' : 'read',
    limitsOwner: 'DeviceSandboxV2',
    member: operationId === 'device.events.subscribe' ? 'subscribe' : memberFor(operationId),
    modes,
    module,
    operation: operationId,
    resourceSchemaId: 'DeviceFieldResourceV1',
    resultSchemaId: operationId === 'device.events.subscribe'
      ? 'DeviceSubscriptionV1'
      : operationId === 'device.summary.read'
      ? 'HoloDeviceSummaryV1'
      : `DeviceReadingV1.${operationId}`
  })

export const DEVICE_OPERATION_REGISTRY_V1: readonly OperationDescriptorV1[] = Object.freeze([
  ...DEVICE_OPERATIONS_V1.filter(value =>
    value !== 'device.events.subscribe' && value !== 'device.connectivity.wifi.identity.read'
  ).flatMap(value => [
    descriptor(value, 'holo:device', ['sync']),
    descriptor(value, 'holo:device/promises', ['promise'])
  ]),
  descriptor('device.connectivity.wifi.identity.read', 'holo:device/promises', ['promise']),
  descriptor('device.events.subscribe', 'holo:device/promises', ['promise'])
])
