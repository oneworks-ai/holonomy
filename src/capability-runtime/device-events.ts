import { DEVICE_EVENT_KINDS_V1 } from './device-provider.js'
import { normalizeDeviceReadingV1 } from './device-readings.js'
import type { DeviceEventKindV1, DeviceReadingV1, DeviceValueMapV1 } from './device-types.js'
import { invalidPolicy } from './errors.js'
import { deepFreeze, exact, finiteNumber, integer, literal, record, required, stringSet } from './validation.js'

const EVENT_OPERATION = Object.freeze(
  {
    connectivity: 'device.connectivity.read',
    display: 'device.display.read',
    lifecycle: 'device.lifecycle.read',
    power: 'device.power.read',
    thermal: 'device.thermal.read'
  } as const
)

export interface DeviceEventBaseV1<K extends DeviceEventKindV1> {
  readonly kind: K
  readonly observedAt: number
  readonly phase: 'change' | 'snapshot'
  readonly reading: DeviceReadingV1<DeviceValueMapV1[typeof EVENT_OPERATION[K]]>
  readonly schemaVersion: 1
  readonly sequence: number
}
export interface DeviceOverflowEventV1 {
  readonly dropped: number
  readonly kind: 'overflow'
  readonly observedAt: number
  readonly requiredRevisions: Readonly<Partial<Record<DeviceEventKindV1, number>>>
  readonly resyncRequired: true
  readonly schemaVersion: 1
  readonly sequence: number
}
export type HoloDeviceEventV1 = DeviceEventBaseV1<DeviceEventKindV1> | DeviceOverflowEventV1

const eventCommon = (input: Record<string, unknown>) => ({
  observedAt: finiteNumber(required(input, 'observedAt'), 0, Number.MAX_SAFE_INTEGER),
  schemaVersion: 1 as const,
  sequence: integer(required(input, 'sequence'), 1, Number.MAX_SAFE_INTEGER)
})

export const normalizeDeviceEventV1 = (value: unknown): HoloDeviceEventV1 => {
  const candidate = record(value)
  if (required(candidate, 'schemaVersion') !== 1) return invalidPolicy()
  if (candidate.kind === 'overflow') {
    const input = exact(candidate, [
      'dropped',
      'kind',
      'observedAt',
      'requiredRevisions',
      'resyncRequired',
      'schemaVersion',
      'sequence'
    ])
    if (required(input, 'resyncRequired') !== true) return invalidPolicy()
    const revisionsInput = record(required(input, 'requiredRevisions'))
    const revisions = Object.create(null) as Record<string, number>
    for (const kind of Object.keys(revisionsInput).sort()) {
      if (!DEVICE_EVENT_KINDS_V1.includes(kind as DeviceEventKindV1)) return invalidPolicy()
      revisions[kind] = integer(revisionsInput[kind], 0, Number.MAX_SAFE_INTEGER)
    }
    if (Object.keys(revisions).length === 0) return invalidPolicy()
    return deepFreeze({
      ...eventCommon(input),
      dropped: integer(required(input, 'dropped'), 1, Number.MAX_SAFE_INTEGER),
      kind: 'overflow',
      requiredRevisions: revisions,
      resyncRequired: true
    })
  }
  const input = exact(candidate, ['kind', 'observedAt', 'phase', 'reading', 'schemaVersion', 'sequence'])
  const kind = literal(required(input, 'kind'), DEVICE_EVENT_KINDS_V1)
  return deepFreeze({
    ...eventCommon(input),
    kind,
    phase: literal(required(input, 'phase'), ['change', 'snapshot'] as const),
    reading: normalizeDeviceReadingV1(EVENT_OPERATION[kind], required(input, 'reading'))
  }) as HoloDeviceEventV1
}

export const normalizeDeviceSubscriptionOptionsV1 = (value: unknown) => {
  const input = exact(value, ['kinds', 'maxQueuedEvents'])
  return Object.freeze({
    kinds: stringSet(required(input, 'kinds'), DEVICE_EVENT_KINDS_V1, 1, 5),
    ...(Object.hasOwn(input, 'maxQueuedEvents')
      ? { maxQueuedEvents: integer(input.maxQueuedEvents, 1, 4096) }
      : {})
  })
}
