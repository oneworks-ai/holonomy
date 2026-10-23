import { HoloGuestErrorV1 } from '@holonomyjs/runtime/kernel/guest-errors'
import { DEVICE_EVENT_KINDS_V1 } from './device-provider.js'
import type { DeviceEventKindV1 } from './device-types.js'

const invalid = (): never => {
  throw new HoloGuestErrorV1('holo.invalid_arguments', 'device.events.acknowledgeResync', false)
}

export const validateDeviceResyncAckV1 = (
  value: unknown,
  required: ReadonlyMap<DeviceEventKindV1, number>,
  events: ReadonlyMap<DeviceEventKindV1, number>,
  reads: ReadonlyMap<DeviceEventKindV1, number>
): Readonly<Partial<Record<DeviceEventKindV1, number>>> => {
  if (required.size === 0 || value == null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const revisions: Partial<Record<DeviceEventKindV1, number>> = Object.create(null) as Partial<
    Record<DeviceEventKindV1, number>
  >
  for (const [key, revision] of Object.entries(value)) {
    if (!DEVICE_EVENT_KINDS_V1.includes(key as DeviceEventKindV1)) return invalid()
    if (!Number.isSafeInteger(revision) || revision < 0) return invalid()
    const kind = key as DeviceEventKindV1
    if (revision > Math.max(events.get(kind) ?? -1, reads.get(kind) ?? -1)) return invalid()
    revisions[kind] = revision
  }
  for (const [kind, minimum] of required) {
    if (typeof revisions[kind] !== 'number' || revisions[kind] < minimum) return invalid()
  }
  return Object.freeze(revisions)
}
