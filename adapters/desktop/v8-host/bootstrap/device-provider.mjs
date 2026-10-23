/* eslint-disable max-lines -- The single Host Device Provider owns admission, readings, and generation-bound events. */
import {
  CapabilityInvocationError,
  DEVICE_OPERATIONS_V1,
  DEVICE_OPERATION_PRIVACY_TIER_V1,
  compileDeviceProviderDescriptorV1,
  normalizeDeviceEventV1,
  normalizeDeviceReadingV1,
  normalizeDeviceSummaryV1,
  trustedInvocationValueFromJsonV1
} from '../../../../packages/runtime/src/kernel/index.ts'

const REQUIRED = new Set([
  'device.display.read',
  'device.events.subscribe',
  'device.form-factor.read',
  'device.input.read',
  'device.lifecycle.read',
  'device.summary.read'
])
const EVENT_OPERATION = Object.freeze({
  display: 'device.display.read',
  lifecycle: 'device.lifecycle.read'
})
const SUMMARY_FIELDS = Object.freeze({
  display: 'device.display.read',
  formFactor: 'device.form-factor.read',
  input: 'device.input.read',
  lifecycle: 'device.lifecycle.read',
  power: 'device.power.read'
})
const PRECISIONS = Object.freeze(['coarse', 'standard', 'exact'])
const HOST_LIMITS = Object.freeze({ maxSubscriptions: 128, maxEventsPerSecond: 128, maxQueuedEvents: 256 })
const POLL_INTERVAL_MS = 250

export const NATIVE_DESKTOP_DEVICE_DESCRIPTOR_V1 = compileDeviceProviderDescriptorV1({
  operations: DEVICE_OPERATIONS_V1.map(operation =>
    REQUIRED.has(operation)
      ? {
        eventKinds: operation === 'device.events.subscribe' ? ['display', 'lifecycle'] : [],
        maxPrecision: 'exact',
        operation,
        permissionModel: operation === 'device.form-factor.read' ? 'host' : 'hostAndPlatform',
        supportLevel: 'required'
      }
      : {
        eventKinds: [],
        maxPrecision: 'none',
        operation,
        permissionModel: 'none',
        supportLevel: 'unsupported'
      }
  ),
  providerVersion: '1.0.0',
  schemaVersion: 1,
  target: 'desktop'
})

const denied = operation => {
  throw new CapabilityInvocationError('capability.denied', operation)
}
const protocol = operation => {
  throw new CapabilityInvocationError('provider.protocol_error', operation)
}
const rank = precision => PRECISIONS.indexOf(precision)
const minPrecision = (...values) => PRECISIONS[Math.min(...values.map(rank))]
const projected = reading => JSON.stringify([reading.status, reading.precision, reading.value])

/** Host-only binding. Rust owns the OS source and its operation-local revisions. */
export const createPrivateNativeDesktopDeviceProviderV1 = ({
  cancelSchedule,
  generation = 1,
  nativeDevice,
  now,
  policy,
  schedule
}) => {
  if (typeof nativeDevice !== 'function' || typeof now !== 'function' || generation !== 1) {
    throw new TypeError('Native Device Host binding is invalid')
  }
  const send = input => {
    let response
    try {
      response = JSON.parse(nativeDevice(JSON.stringify({ schemaVersion: 1, generation, ...input })))
    } catch {
      throw new CapabilityInvocationError('provider.unavailable', input.operation ?? 'device.summary.read')
    }
    if (response?.schemaVersion !== 1 || typeof response.ok !== 'boolean') {
      protocol(input.operation ?? 'device.summary.read')
    }
    if (response.ok !== true) {
      throw new CapabilityInvocationError(
        response.code ?? 'provider.unavailable',
        input.operation ?? 'device.summary.read'
      )
    }
    return response.value
  }
  send({ kind: 'install', policy })
  const subscriptions = new Map()
  let nextId = 0
  let sequence = 0
  let lastPollAt = -Infinity
  let pollTimer
  let rateWindow = -Infinity
  let emittedInWindow = 0
  let closed = false
  const rateLimit = Math.min(policy.maxEventsPerSecond, HOST_LIMITS.maxEventsPerSecond)
  const resetRate = () => {
    const current = now()
    if (current - rateWindow >= 1000) {
      rateWindow = current
      emittedInWindow = 0
    }
    return emittedInWindow < rateLimit
  }
  const nextEvent = (kind, phase, reading) =>
    normalizeDeviceEventV1({
      kind,
      observedAt: reading.observedAt,
      phase,
      reading,
      schemaVersion: 1,
      sequence: ++sequence
    })
  const selected = (operation, authority) => {
    const bindings = authority.bindings.filter(binding =>
      binding.providerModule === 'host.device' && binding.constraints.operations?.includes(operation)
    )
    const ceiling = policy.operations[operation]
    if (bindings.length === 0 || ceiling?.access !== 'allow') denied(operation)
    const maxPrivacyTier = Math.min(
      ceiling.maxPrivacyTier,
      ...bindings.map(binding => binding.constraints.maxPrivacyTier)
    )
    if (
      !Number.isSafeInteger(maxPrivacyTier) ||
      maxPrivacyTier < DEVICE_OPERATION_PRIVACY_TIER_V1[operation]
    ) denied(operation)
    const maxPrecision = minPrecision(
      'exact',
      ceiling.maxPrecision,
      ...bindings.map(binding => binding.constraints.maxPrecision)
    )
    if (maxPrecision == null) denied(operation)
    return { maxPrecision, maxPrivacyTier }
  }
  const read = (operation, limits) => {
    if (closed) throw new CapabilityInvocationError('runtime.generation_stale', operation)
    const value = send({ kind: 'read', operation, ...limits })
    if (operation === 'device.summary.read') {
      const summary = normalizeDeviceSummaryV1(value)
      for (const [field, childOperation] of Object.entries(SUMMARY_FIELDS)) {
        const child = summary[field]
        const ceiling = policy.operations[childOperation]
        if (
          ceiling == null || DEVICE_OPERATION_PRIVACY_TIER_V1[childOperation] > ceiling.maxPrivacyTier ||
          DEVICE_OPERATION_PRIVACY_TIER_V1[childOperation] > limits.maxPrivacyTier
        ) {
          if (child.status !== 'permissionDenied' || child.revision !== 0) protocol(operation)
        } else if (
          child.status === 'available' && rank(child.precision) > rank(
              minPrecision(limits.maxPrecision, ceiling.maxPrecision)
            )
        ) protocol(operation)
      }
      return summary
    }
    const reading = normalizeDeviceReadingV1(operation, value)
    if (REQUIRED.has(operation) && reading.status === 'unsupported') protocol(operation)
    if (reading.status === 'available' && rank(reading.precision) > rank(limits.maxPrecision)) protocol(operation)
    return reading
  }
  const emit = (record, event) => {
    if (!resetRate()) return false
    emittedInWindow++
    const snapshot = trustedInvocationValueFromJsonV1(event, 'result')
    for (const listener of record.listeners) listener(snapshot)
    return true
  }
  const flush = record => {
    while (record.baseline.length > 0 && resetRate()) {
      emit(record, nextEvent(...record.baseline.shift()))
    }
    if (record.baseline.length > 0 || record.pending.size === 0) return
    const latest = [...record.pending.entries()].sort(([left], [right]) => left.localeCompare(right))
    if (record.dropped > 0 && !record.overflowEmitted && resetRate()) {
      emit(
        record,
        normalizeDeviceEventV1({
          dropped: record.dropped,
          kind: 'overflow',
          observedAt: now(),
          requiredRevisions: Object.fromEntries(latest.map(([kind, reading]) => [kind, reading.revision])),
          resyncRequired: true,
          schemaVersion: 1,
          sequence: ++sequence
        })
      )
      record.overflowEmitted = true
    }
    if (record.dropped > 0 && !record.overflowEmitted) return
    for (const [kind, reading] of latest) {
      if (!resetRate()) break
      emit(record, nextEvent(kind, 'change', reading))
      record.pending.delete(kind)
    }
    if (record.pending.size === 0) {
      record.dropped = 0
      record.overflowEmitted = false
    }
  }
  const closeRecord = bindingId => {
    const record = subscriptions.get(bindingId)
    if (record == null) return
    subscriptions.delete(bindingId)
    record.listeners.clear()
    record.baseline.length = 0
    record.latest.clear()
    record.pending.clear()
    if (subscriptions.size === 0 && pollTimer != null) {
      cancelSchedule?.(pollTimer)
      pollTimer = undefined
    }
  }
  let provider
  const schedulePoll = () => {
    if (schedule == null || closed || subscriptions.size === 0 || pollTimer != null) return
    pollTimer = schedule(() => {
      pollTimer = undefined
      if (closed || subscriptions.size === 0) return
      provider.poll()
      schedulePoll()
    }, POLL_INTERVAL_MS)
  }
  provider = {
    execution: 'sync',
    module: 'host.device',
    invoke(context, authority) {
      const operation = context.operation
      if (closed || context.runtime.generation !== generation) denied(operation)
      const resource = context.resource.requested
      if (resource.kind !== 'deviceField' || resource.operation !== operation) denied(operation)
      const limits = selected(operation, authority)
      if (resource.privacyTier > limits.maxPrivacyTier) denied(operation)
      if (operation !== 'device.events.subscribe') {
        return authority.complete(trustedInvocationValueFromJsonV1(read(operation, limits), 'result'))
      }
      const requested = context.arguments.kinds
      if (
        !Array.isArray(requested) || requested.length === 0 ||
        requested.some(kind => EVENT_OPERATION[kind] == null) ||
        subscriptions.size >= Math.min(policy.maxSubscriptions, HOST_LIMITS.maxSubscriptions)
      ) denied(operation)
      const subscriptionBindings = authority.bindings.filter(binding =>
        binding.providerModule === 'host.device' &&
        binding.constraints.operations?.includes('device.events.subscribe')
      )
      if (
        subscriptionBindings.length === 0 ||
        subscriptionBindings.some(binding =>
          !Number.isSafeInteger(binding.constraints.maxQueuedEvents) || binding.constraints.maxQueuedEvents < 1
        )
      ) denied(operation)
      const maxQueuedEvents = Math.min(
        policy.maxQueuedEvents,
        HOST_LIMITS.maxQueuedEvents,
        context.arguments.maxQueuedEvents ?? policy.maxQueuedEvents,
        ...subscriptionBindings.map(binding => binding.constraints.maxQueuedEvents)
      )
      if (!Number.isSafeInteger(maxQueuedEvents) || maxQueuedEvents < 1) denied(operation)
      const kinds = [...new Set(requested)].sort()
      const baseline = kinds.map(kind => {
        const childOperation = EVENT_OPERATION[kind]
        const childLimits = selected(childOperation, authority)
        const reading = read(childOperation, childLimits)
        return [kind, 'snapshot', reading, childLimits]
      })
      if (nextId >= Number.MAX_SAFE_INTEGER) denied(operation)
      const bindingId = `native-device-${generation}-${++nextId}`
      const startSequence = sequence
      const record = {
        baseline: baseline.map(([kind, phase, reading]) => [kind, phase, reading]),
        dropped: 0,
        kinds,
        limits: Object.fromEntries(baseline.map(([kind, , , childLimits]) => [kind, childLimits])),
        last: new Map(
          baseline.map(([kind, , reading]) => [kind, { revision: reading.revision, value: projected(reading) }])
        ),
        latest: new Map(baseline.map(([kind, , reading]) => [kind, reading])),
        listeners: new Set(),
        maxQueuedEvents,
        overflowEmitted: false,
        pending: new Map()
      }
      subscriptions.set(bindingId, record)
      try {
        schedulePoll()
        return authority.complete(
          trustedInvocationValueFromJsonV1({
            binding: { bindingId, generation },
            maxQueuedEvents,
            resourceType: 'device.subscription',
            startSequence
          }, 'result'),
          [{
            bindingId,
            close: () => closeRecord(bindingId),
            eventSchemaId: 'HoloDeviceEventV1',
            resource,
            resourceType: 'device.subscription',
            subscribe(listener) {
              if (!subscriptions.has(bindingId)) return () => undefined
              record.listeners.add(listener)
              flush(record)
              return () => {
                record.listeners.delete(listener)
                if (record.listeners.size === 0) closeRecord(bindingId)
              }
            }
          }]
        )
      } catch (error) {
        closeRecord(bindingId)
        throw error
      }
    },
    maxQueuedEventsFor: bindingId => subscriptions.get(bindingId)?.maxQueuedEvents,
    overflow(bindingId, lost) {
      const record = subscriptions.get(bindingId)
      if (record == null) return []
      const latest = new Map()
      const required = new Map()
      let dropped = 0
      for (const event of lost) {
        if (event.kind === 'overflow') {
          dropped += event.dropped
          for (const [kind, revision] of Object.entries(event.requiredRevisions)) {
            required.set(kind, Math.max(required.get(kind) ?? 0, revision))
          }
          continue
        }
        dropped++
        required.set(event.kind, Math.max(required.get(event.kind) ?? 0, event.reading.revision))
        const prior = latest.get(event.kind)
        if (prior == null || prior.reading.revision < event.reading.revision) latest.set(event.kind, event)
      }
      for (const [kind, revision] of required) {
        if (latest.has(kind)) continue
        const reading = record.latest.get(kind)
        if (reading != null && reading.revision >= revision) latest.set(kind, { reading })
      }
      if (required.size === 0) return []
      const events = [...latest.entries()].sort(([left], [right]) => left.localeCompare(right))
      return [
        normalizeDeviceEventV1({
          dropped,
          kind: 'overflow',
          observedAt: now(),
          requiredRevisions: Object.fromEntries(
            [...required.entries()].sort(([left], [right]) => left.localeCompare(right))
          ),
          resyncRequired: true,
          schemaVersion: 1,
          sequence: ++sequence
        }),
        ...events.map(([kind, event]) => nextEvent(kind, 'change', event.reading))
      ]
    },
    poll() {
      if (closed || subscriptions.size === 0) return []
      const current = now()
      for (const record of subscriptions.values()) if (record.listeners.size > 0) flush(record)
      if (current - lastPollAt < POLL_INTERVAL_MS) return []
      lastPollAt = current
      for (const record of subscriptions.values()) {
        if (record.listeners.size === 0) continue
        for (const kind of record.kinds) {
          const reading = read(EVENT_OPERATION[kind], record.limits[kind])
          const prior = record.last.get(kind)
          const value = projected(reading)
          record.last.set(kind, { revision: reading.revision, value })
          record.latest.set(kind, reading)
          if (prior != null && reading.revision > prior.revision && value !== prior.value) {
            if (record.pending.has(kind)) record.dropped++
            record.pending.set(kind, reading)
          }
        }
        flush(record)
      }
      return []
    }
  }
  return Object.freeze({
    descriptor: NATIVE_DESKTOP_DEVICE_DESCRIPTOR_V1,
    provider,
    close() {
      if (closed) return
      closed = true
      for (const bindingId of subscriptions.keys()) closeRecord(bindingId)
      if (pollTimer != null) cancelSchedule?.(pollTimer)
      pollTimer = undefined
      send({ kind: 'close' })
    }
  })
}
