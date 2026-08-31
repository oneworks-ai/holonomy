import type { MaterializationInputV1 } from '@holonomyjs/runtime/kernel/broker-policy-types'
import type { CapabilityRequirementV1 } from '@holonomyjs/runtime/kernel/capability-types'
import { capabilityFailure } from '@holonomyjs/runtime/kernel/errors'
import type { DeviceOperationV1 } from '@holonomyjs/runtime/kernel/registry-types'

export const dynamicDeviceRequirementV1 = (input: MaterializationInputV1): CapabilityRequirementV1 => {
  if (input.resource.kind !== 'deviceField' || input.descriptor.operation !== 'device.events.subscribe') {
    return capabilityFailure('capability.denied', input.descriptor.operation, input.resource.semanticResourceDigest)
  }
  const kinds = (input.arguments.value as { kinds?: unknown }).kinds
  const requestedQueue = (input.arguments.value as { maxQueuedEvents?: unknown }).maxQueuedEvents
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some(kind => typeof kind !== 'string')) {
    return capabilityFailure('argument.invalid', input.descriptor.operation, input.resource.semanticResourceDigest)
  }
  const subscriptionCeiling = input.policy.device.operations['device.events.subscribe']
  const subscriptionProvider = input.deviceProviderDescriptor?.operations.find(
    item => item.operation === 'device.events.subscribe'
  )
  if (
    input.policy.device.maxSubscriptions < 1 || input.policy.device.maxQueuedEvents < 1 ||
    subscriptionCeiling == null ||
    subscriptionProvider == null || subscriptionProvider.supportLevel === 'unsupported' ||
    kinds.some(kind => !subscriptionProvider.eventKinds.includes(kind as never))
  ) {
    return capabilityFailure('policy.denied', input.descriptor.operation, input.resource.semanticResourceDigest)
  }
  const maxQueuedEvents = requestedQueue == null
    ? input.policy.device.maxQueuedEvents
    : typeof requestedQueue === 'number' && Number.isSafeInteger(requestedQueue) && requestedQueue >= 1 &&
        requestedQueue <= input.policy.device.maxQueuedEvents
    ? requestedQueue
    : capabilityFailure('policy.denied', input.descriptor.operation, input.resource.semanticResourceDigest)
  const operationForKind: Readonly<Record<string, DeviceOperationV1>> = {
    connectivity: 'device.connectivity.read',
    display: 'device.display.read',
    lifecycle: 'device.lifecycle.read',
    power: 'device.power.read',
    thermal: 'device.thermal.read'
  }
  const descriptors = kinds.map(kind => {
    const operation = operationForKind[kind]
    const ceiling = operation == null ? undefined : input.policy.device.operations[operation]
    const provider = input.deviceProviderDescriptor?.operations.find(item => item.operation === operation)
    if (operation == null || ceiling == null || provider == null || provider.supportLevel === 'unsupported') {
      return capabilityFailure('policy.denied', input.descriptor.operation, input.resource.semanticResourceDigest)
    }
    return { ceiling, operation, provider }
  })
  const tier = Math.max(subscriptionCeiling.maxPrivacyTier, ...descriptors.map(item => item.ceiling.maxPrivacyTier))
  const precision = ['coarse', 'standard', 'exact'] as const
  const maximum = precision[
    Math.min(
      ...descriptors.map(item =>
        Math.min(precision.indexOf(item.ceiling.maxPrecision), precision.indexOf(item.provider.maxPrecision as never))
      )
    )
  ]!
  const names = [
    ...new Set(
      descriptors.map(item =>
        item.operation === 'device.power.read' || item.operation === 'device.display.read' ||
          item.operation === 'device.lifecycle.read'
          ? 'host.device.summary' as const
          : 'host.device.state' as const
      )
    )
  ]
  return {
    anyOf: [{
      allOf: names.map(name => ({
        constraints: {
          maxPrecision: maximum,
          maxPrivacyTier: tier,
          maxQueuedEvents,
          operations: ['device.events.subscribe', ...descriptors.map(item => item.operation)]
        },
        name,
        version: 1 as const
      })),
      branchId: 'device-events'
    }]
  }
}
