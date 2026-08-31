import { invalidPolicy } from './errors.js'
import { OBSERVER_EVENTS_V1 } from './registry-types.js'
import type { RuntimeObserverSelectableEventNameV1 } from './registry-types.js'
import { array, deepFreeze, exact, integer, literal, required, stringSet } from './validation.js'

export interface RuntimeObserverDescriptorV1 {
  readonly cost: 'high' | 'low'
  readonly event: RuntimeObserverSelectableEventNameV1
  readonly optIn: boolean
  readonly supportLevel: 'optional' | 'required' | 'unsupported'
}

export interface RuntimeObserverPlatformDescriptorV1 {
  readonly events: readonly RuntimeObserverDescriptorV1[]
  readonly maxObserverCallbackMs: number
  readonly maxQueuedEvents: number
  readonly schemaVersion: 1
}

export interface RuntimeObserverRegistrationV1 {
  readonly acceptHighCost?: boolean
  readonly callbackTimeoutMs?: number
  readonly events: readonly RuntimeObserverSelectableEventNameV1[]
  readonly maxQueuedEvents?: number
}

export interface NormalizedRuntimeObserverAdmissionV1 {
  readonly callbackTimeoutMs: number
  readonly events: readonly RuntimeObserverSelectableEventNameV1[]
  readonly maxQueuedEvents: number
}

export const compileRuntimeObserverPlatformDescriptorV1 = (
  value: unknown
): RuntimeObserverPlatformDescriptorV1 => {
  const input = exact(value, ['events', 'maxObserverCallbackMs', 'maxQueuedEvents', 'schemaVersion'])
  if (required(input, 'schemaVersion') !== 1) return invalidPolicy()
  const events = array(required(input, 'events'), OBSERVER_EVENTS_V1.length, OBSERVER_EVENTS_V1.length)
    .map(item => {
      const row = exact(item, ['cost', 'event', 'optIn', 'supportLevel'])
      const supportLevel = literal(required(row, 'supportLevel'), ['optional', 'required', 'unsupported'] as const)
      const cost = literal(required(row, 'cost'), ['high', 'low'] as const)
      const optIn = required(row, 'optIn')
      if (typeof optIn !== 'boolean') return invalidPolicy()
      if (supportLevel === 'unsupported' && (cost !== 'low' || optIn)) return invalidPolicy()
      return Object.freeze({
        cost,
        event: literal(required(row, 'event'), OBSERVER_EVENTS_V1),
        optIn,
        supportLevel
      })
    })
  if (new Set(events.map(item => item.event)).size !== OBSERVER_EVENTS_V1.length) return invalidPolicy()
  events.sort((left, right) => left.event < right.event ? -1 : 1)
  if (events.some((item, index) => item.event !== OBSERVER_EVENTS_V1[index])) return invalidPolicy()
  return deepFreeze({
    events,
    maxObserverCallbackMs: integer(required(input, 'maxObserverCallbackMs'), 1, 120_000),
    maxQueuedEvents: integer(required(input, 'maxQueuedEvents'), 0, 4096),
    schemaVersion: 1
  })
}

export const compileRuntimeObserverAdmissionV1 = (
  registrationValue: unknown,
  policyValue: Readonly<{
    maxObserverCallbackMs: number
    maxQueuedEvents: number
    observerEvents: readonly RuntimeObserverSelectableEventNameV1[]
  }>,
  platformValue: unknown,
  hostCaps: Readonly<{ maxObserverCallbackMs: number; maxQueuedEvents: number }>
): NormalizedRuntimeObserverAdmissionV1 => {
  const registration = exact(registrationValue, [
    'acceptHighCost',
    'callbackTimeoutMs',
    'events',
    'maxQueuedEvents'
  ])
  const platform = compileRuntimeObserverPlatformDescriptorV1(platformValue)
  const events = stringSet(required(registration, 'events'), OBSERVER_EVENTS_V1, 1, OBSERVER_EVENTS_V1.length)
  const descriptorByEvent = new Map(platform.events.map(item => [item.event, item]))
  const policyEvents = new Set(policyValue.observerEvents)
  for (const event of events) {
    const descriptor = descriptorByEvent.get(event)!
    if (!policyEvents.has(event) || descriptor.supportLevel === 'unsupported') return invalidPolicy()
    if ((descriptor.cost === 'high' || descriptor.optIn) && registration.acceptHighCost !== true) {
      return invalidPolicy()
    }
  }
  const registrationTimeout = Object.hasOwn(registration, 'callbackTimeoutMs')
    ? integer(registration.callbackTimeoutMs, 1, 120_000)
    : Number.MAX_SAFE_INTEGER
  const registrationQueue = Object.hasOwn(registration, 'maxQueuedEvents')
    ? integer(registration.maxQueuedEvents, 1, 4096)
    : Number.MAX_SAFE_INTEGER
  return Object.freeze({
    callbackTimeoutMs: Math.min(
      registrationTimeout,
      policyValue.maxObserverCallbackMs,
      integer(hostCaps.maxObserverCallbackMs, 1, 120_000),
      platform.maxObserverCallbackMs
    ),
    events,
    maxQueuedEvents: Math.min(
      registrationQueue,
      policyValue.maxQueuedEvents,
      integer(hostCaps.maxQueuedEvents, 0, 4096),
      platform.maxQueuedEvents
    )
  })
}
