// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import {
  CapabilityInvocationError,
  normalizeDeviceEventV1,
  normalizeDeviceReadingV1,
  normalizeDeviceSummaryV1,
  trustedInvocationValueFromJsonV1
} from '../../../dist/capability-runtime/index.js'

import { NodeFilesystemProviderV1 } from './capability-fs-provider.mjs'
import { NodeNetworkAuthorizationProviderV1 } from './capability-network-provider.mjs'
import { NodeProcessProviderV1 } from './capability-process-provider.mjs'
import { assertNodeDeviceAuthorityV1, assertNodeSystemAuthorityV1 } from './capability-provider-authority.mjs'

class NodeSystemProviderV1 {
  execution = 'sync'
  module = 'host.system'
  #projection

  constructor(projection) {
    this.#projection = projection
  }

  invoke(context, authority) {
    const resource = context.resource.requested
    if (resource.kind !== 'systemField') throw new CapabilityInvocationError('resource.invalid', context.operation)
    assertNodeSystemAuthorityV1(context, authority)
    const field = this.#projection.fields[resource.field]
    if (field == null || field.mode === 'unavailable') {
      throw new CapabilityInvocationError('capability.denied', context.operation, resource.semanticResourceDigest)
    }
    return authority.complete(trustedInvocationValueFromJsonV1(field.value, 'result'))
  }
}

class NodeDeviceProviderV1 {
  execution = 'sync'
  module = 'host.device'
  #readings
  #summary
  #nextSubscriptionId = 1

  constructor(configuration) {
    this.#readings = Object.freeze(Object.fromEntries(
      Object.entries(configuration.deviceReadings).map(([operation, reading]) => [
        operation,
        normalizeDeviceReadingV1(operation, reading)
      ])
    ))
    this.#summary = configuration.deviceSummary == null
      ? undefined
      : normalizeDeviceSummaryV1(configuration.deviceSummary)
  }

  invoke(context, authority) {
    const resource = context.resource.requested
    if (resource.kind !== 'deviceField') throw new CapabilityInvocationError('resource.invalid', context.operation)
    assertNodeDeviceAuthorityV1(context, authority)
    if (resource.operation === 'device.events.subscribe') {
      const bindingId = `device-subscription-${this.#nextSubscriptionId++}`
      const listeners = new Set()
      const kinds = context.arguments.kinds
      const maxQueuedEvents = Math.min(...authority.bindings.map(binding => binding.constraints.maxQueuedEvents))
      if (!Number.isSafeInteger(maxQueuedEvents) || maxQueuedEvents < 1) {
        throw new CapabilityInvocationError('capability.denied', context.operation)
      }
      let sequence = 0
      let closed = false
      const emit = value => {
        const event = normalizeDeviceEventV1(value)
        for (const listener of listeners) listener(trustedInvocationValueFromJsonV1(event, 'result'))
      }
      const operationForKind = {
        connectivity: 'device.connectivity.read',
        display: 'device.display.read',
        lifecycle: 'device.lifecycle.read',
        power: 'device.power.read',
        thermal: 'device.thermal.read'
      }
      const startSequence = sequence
      const baseline = () => {
        for (const kind of [...kinds].sort()) {
          const reading = this.#readings[operationForKind[kind]]
          if (reading != null) {
            emit({
              kind,
              observedAt: reading.observedAt,
              phase: 'snapshot',
              reading,
              schemaVersion: 1,
              sequence: ++sequence
            })
          }
        }
      }
      const facade = {
        binding: { bindingId, generation: context.runtime.generation },
        maxQueuedEvents,
        resourceType: 'device.subscription',
        startSequence
      }
      return authority.complete(trustedInvocationValueFromJsonV1(facade, 'result'), [{
        bindingId,
        close: () => {
          closed = true
          listeners.clear()
        },
        eventSchemaId: 'HoloDeviceEventV1',
        resource,
        resourceType: 'device.subscription',
        subscribe: listener => {
          if (closed) return () => undefined
          listeners.add(listener)
          queueMicrotask(baseline)
          return () => listeners.delete(listener)
        }
      }])
    }
    const value = resource.operation === 'device.summary.read'
      ? this.#summary
      : this.#readings[resource.operation]
    if (value == null) {
      throw new CapabilityInvocationError('provider.unavailable', context.operation, resource.semanticResourceDigest)
    }
    return authority.complete(trustedInvocationValueFromJsonV1(value, 'result'))
  }
}

export const createNodeCapabilityProvidersV1 = (session, generation, processBackendRegistry) => {
  const configuration = session.providerConfiguration
  return new Map([
    ['host.device', new NodeDeviceProviderV1(configuration)],
    ['host.fs', new NodeFilesystemProviderV1(configuration.filesystemRoots)],
    ['host.network', new NodeNetworkAuthorizationProviderV1('host.network', generation)],
    ['host.network.mock', new NodeNetworkAuthorizationProviderV1('host.network.mock', generation)],
    ...(configuration.processProfile == null
      ? []
      : [[
        'host.process',
        new NodeProcessProviderV1(
          configuration.processProfile,
          session.runtimeCreation.configuration.sandboxPolicy.process,
          generation,
          processBackendRegistry
        )
      ]]),
    ['host.system', new NodeSystemProviderV1(session.runtimeCreation.configuration.systemProjection)]
  ])
}
