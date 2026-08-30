import { invalidPolicy } from './errors.js'
import { OBSERVER_EVENTS_V1 } from './registry-types.js'
import type { RuntimeObserverSelectableEventNameV1 } from './registry-types.js'
import { deepFreeze, exact, integer, record, required } from './validation.js'

export interface ObserverOverflowPayloadV1 {
  readonly dropped: number
  readonly droppedByEvent: Readonly<Partial<Record<RuntimeObserverSelectableEventNameV1, number>>>
  readonly firstDroppedSequence: number
  readonly lastDroppedSequence: number
}

export const normalizeObserverOverflowPayloadV1 = (value: unknown): ObserverOverflowPayloadV1 => {
  const input = exact(value, [
    'dropped',
    'droppedByEvent',
    'firstDroppedSequence',
    'lastDroppedSequence'
  ])
  const byEventInput = record(required(input, 'droppedByEvent'))
  const droppedByEvent = Object.create(null) as Record<string, number>
  let sum = 0
  for (const event of Object.keys(byEventInput).sort()) {
    if (!OBSERVER_EVENTS_V1.includes(event as RuntimeObserverSelectableEventNameV1)) {
      return invalidPolicy()
    }
    const count = integer(byEventInput[event], 1, Number.MAX_SAFE_INTEGER)
    droppedByEvent[event] = count
    sum += count
  }
  const dropped = integer(required(input, 'dropped'), 1, Number.MAX_SAFE_INTEGER)
  if (sum !== dropped) return invalidPolicy()
  const first = integer(required(input, 'firstDroppedSequence'), 1, Number.MAX_SAFE_INTEGER)
  const last = integer(required(input, 'lastDroppedSequence'), first, Number.MAX_SAFE_INTEGER)
  return deepFreeze({
    dropped,
    droppedByEvent,
    firstDroppedSequence: first,
    lastDroppedSequence: last
  })
}
