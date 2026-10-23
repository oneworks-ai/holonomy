import {
  NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1,
  NATIVE_RUNTIME_OBSERVER_PLATFORM_V1
} from '../../adapters/desktop/v8-host/bootstrap/native-observer-platform.mjs'
import {
  compileRuntimeObserverAdmissionV1,
  compileRuntimeObserverPlatformDescriptorV1
} from '../../dist/capability-runtime/index.js'

import { requireIdentifier, requireRecord } from './validation.mjs'

export const SERVICE_CAPABILITY_OWNER_ID = 'holonomy-service'
export const DEFAULT_RUNTIME_OBSERVER_HOST_CAPS = Object.freeze({
  maxObserverCallbackMs: 120_000,
  maxQueuedEvents: 4096
})

const nativeObserverSupport = new Map(
  compileRuntimeObserverPlatformDescriptorV1(NATIVE_RUNTIME_OBSERVER_PLATFORM_V1).events.map(
    ({ event, supportLevel }) => [event, supportLevel]
  )
)

// With no selected profile, inline Native Host plugins retain Policy event
// availability. Resource-backed profiles are validated separately below.
export const nativeRuntimeObserverPolicyAvailableV1 = (observerIds, policy) =>
  Array.isArray(observerIds) && observerIds.length === 0 &&
  Array.isArray(policy?.observerEvents) &&
  policy.observerEvents.every(event => {
    const support = nativeObserverSupport.get(event)
    return support === 'optional' || support === 'required'
  })

// Native IDs name installed source resources, never Service or Node callbacks.
export const selectNativeRuntimeObserverProfilesV1 = (observerIds, registry, policy) => {
  if (
    !Array.isArray(observerIds) || observerIds.length > 4 ||
    !nativeRuntimeObserverPolicyAvailableV1([], policy)
  ) throw new TypeError('Native Runtime Observer selection is unavailable')
  const selected = []
  let previous
  for (const id of observerIds) {
    if (
      typeof id !== 'string' || id.length < 1 || id.length > 64 ||
      !/^[A-Za-z0-9][\w.-]*$/u.test(id) ||
      previous != null && previous >= id
    ) throw new TypeError('Native Runtime Observer ids are invalid')
    previous = id
    const profile = registry.get(id)
    if (profile == null || typeof profile.version !== 'string' || !/^[a-f\d]{64}$/u.test(profile.version)) {
      throw new TypeError('Native Runtime Observer profile is unavailable')
    }
    const effective = compileRuntimeObserverAdmissionV1(
      profile.registration,
      policy,
      NATIVE_RUNTIME_OBSERVER_PLATFORM_V1,
      NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1
    )
    if (effective.callbackTimeoutMs < 1 || effective.maxQueuedEvents < 1) {
      throw new TypeError('Native Runtime Observer has no effective budget')
    }
    selected.push(Object.freeze({ id, ...profile }))
  }
  return Object.freeze(selected)
}

export const normalizeCapabilityObserverRegistryV1 = value => {
  const entries = value instanceof Map
    ? [...value.entries()]
    : Object.entries(value == null ? {} : requireRecord(value, 'Runtime Observer registry'))
  const output = new Map()
  for (const [idValue, descriptorValue] of entries) {
    const bindingId = requireIdentifier(idValue, 'Runtime Observer registration id')
    const descriptor = requireRecord(descriptorValue, 'Runtime Observer registration')
    if (
      Object.keys(descriptor).some(key =>
        !['bindingId', 'observer', 'ownerId', 'registration', 'version'].includes(key)
      ) ||
      descriptor.bindingId != null && descriptor.bindingId !== bindingId ||
      descriptor.ownerId != null && descriptor.ownerId !== SERVICE_CAPABILITY_OWNER_ID
    ) {
      throw new TypeError('Runtime Observer registration contains an unknown field')
    }
    if (typeof descriptor.observer !== 'function') throw new TypeError('Runtime Observer callback is invalid')
    const version = descriptor.version ?? '1'
    if (typeof version !== 'string' || version.length === 0 || version.length > 64) {
      throw new TypeError('Runtime Observer registration version is invalid')
    }
    output.set(
      bindingId,
      Object.freeze({
        bindingId,
        observer: descriptor.observer,
        ownerId: SERVICE_CAPABILITY_OWNER_ID,
        registration: descriptor.registration,
        version
      })
    )
  }
  return output
}

export const validateCapabilityObserverBindingsV1 = (
  observerIds,
  registry,
  policy,
  platform,
  hostCaps = DEFAULT_RUNTIME_OBSERVER_HOST_CAPS
) => {
  for (const observerId of observerIds) {
    const binding = registry.get(observerId)
    if (binding == null) throw new TypeError('Runtime Observer registration is unavailable')
    compileRuntimeObserverAdmissionV1(binding.registration, policy, platform, hostCaps)
  }
}
