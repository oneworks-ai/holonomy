import { HoloGuestErrorV1 } from '@holonomyjs/runtime/kernel/guest-errors'
import { normalizeDeviceEventV1 } from './device-events.js'
import type { DeviceEventBaseV1, DeviceOverflowEventV1, HoloDeviceEventV1 } from './device-events.js'
import { DEVICE_EVENT_KINDS_V1 } from './device-provider.js'
import type { DeviceEventKindV1 } from './device-types.js'

type DataEventV1 = DeviceEventBaseV1<DeviceEventKindV1>
type IteratorResultV1 = IteratorResult<HoloDeviceEventV1, undefined>

const doneResult = (): IteratorReturnResult<undefined> => Object.freeze({ done: true, value: undefined })
const eventResult = (value: HoloDeviceEventV1): IteratorYieldResult<HoloDeviceEventV1> =>
  Object.freeze({ done: false, value })

export interface GuestDeviceSubscriptionControllerV1 {
  readonly resource:
    & AsyncIterable<HoloDeviceEventV1>
    & AsyncIterator<HoloDeviceEventV1>
    & Readonly<{
      acknowledgeResync(revisions: unknown): Promise<void>
      close(): Promise<void>
      generation: number
      maxQueuedEvents: number
      startSequence: number
    }>
  accept(value: unknown): void
}

const invalidAck = () =>
  new HoloGuestErrorV1(
    'holo.invalid_arguments',
    'device.events.acknowledgeResync',
    false
  )

const maxRevision = (target: Map<DeviceEventKindV1, number>, kind: DeviceEventKindV1, revision: number) => {
  target.set(kind, Math.max(target.get(kind) ?? 0, revision))
}

export const createGuestDeviceSubscriptionV1 = (
  input: Readonly<{
    generation: number
    kinds: readonly DeviceEventKindV1[]
    maxQueuedEvents: number
    onClose(): void | Promise<void>
    startSequence: number
  }>
): GuestDeviceSubscriptionControllerV1 => {
  const requestedKinds = new Set(input.kinds)
  const queue: HoloDeviceEventV1[] = []
  const waiting: Array<(value: IteratorResultV1) => void> = []
  const observedRevisions = new Map<DeviceEventKindV1, number>()
  const requiredRevisions = new Map<DeviceEventKindV1, number>()
  const coalesced = new Map<DeviceEventKindV1, DataEventV1>()
  let closed = false
  let lastSourceSequence = input.startSequence
  let sequence = input.startSequence

  const deliver = (event: HoloDeviceEventV1) => {
    const pending = waiting.shift()
    if (pending == null) queue.push(event)
    else pending(eventResult(event))
  }

  const overflow = (
    dropped: number,
    observedAt: number,
    revisions: ReadonlyMap<DeviceEventKindV1, number>,
    events: readonly DataEventV1[]
  ) => {
    const existing = queue.find(event => event.kind === 'overflow') as DeviceOverflowEventV1 | undefined
    for (const [kind, revision] of revisions) maxRevision(requiredRevisions, kind, revision)
    for (const event of events) {
      maxRevision(requiredRevisions, event.kind, event.reading.revision)
      const current = coalesced.get(event.kind)
      if (current == null || current.reading.revision < event.reading.revision) coalesced.set(event.kind, event)
    }
    const removed = queue.filter((event): event is DataEventV1 => event.kind !== 'overflow')
    queue.length = 0
    for (const event of removed) {
      maxRevision(requiredRevisions, event.kind, event.reading.revision)
      const current = coalesced.get(event.kind)
      if (current == null || current.reading.revision < event.reading.revision) coalesced.set(event.kind, event)
    }
    if (existing != null) {
      for (const [kind, revision] of Object.entries(existing.requiredRevisions)) {
        maxRevision(requiredRevisions, kind as DeviceEventKindV1, revision!)
      }
    }
    const event = normalizeDeviceEventV1({
      dropped: dropped + removed.length + (existing?.dropped ?? 0),
      kind: 'overflow',
      observedAt,
      requiredRevisions: Object.fromEntries(
        [...requiredRevisions].sort(([left], [right]) => left.localeCompare(right))
      ),
      resyncRequired: true,
      schemaVersion: 1,
      sequence: ++sequence
    })
    deliver(event)
  }

  const deliverData = (event: DataEventV1) => {
    if (queue.length >= input.maxQueuedEvents) {
      overflow(1, event.observedAt, new Map([[event.kind, event.reading.revision]]), [event])
      return
    }
    deliver(normalizeDeviceEventV1({ ...event, sequence: ++sequence }))
  }

  const accept = (value: unknown) => {
    if (closed) return
    const event = normalizeDeviceEventV1(value)
    if (event.sequence <= lastSourceSequence) return
    lastSourceSequence = event.sequence
    if (event.kind === 'overflow') {
      const revisions = new Map(
        Object.entries(event.requiredRevisions).map(([kind, revision]) => [kind as DeviceEventKindV1, revision!])
      )
      overflow(event.dropped, event.observedAt, revisions, [])
      return
    }
    if (!requestedKinds.has(event.kind)) return
    const previousRevision = observedRevisions.get(event.kind) ?? -1
    if (event.reading.revision <= previousRevision) return
    observedRevisions.set(event.kind, event.reading.revision)
    if (requiredRevisions.has(event.kind)) {
      const current = coalesced.get(event.kind)
      if (current == null || current.reading.revision < event.reading.revision) coalesced.set(event.kind, event)
      return
    }
    deliverData(event)
  }

  const acknowledgeResync = async (value: unknown) => {
    if (closed) throw new HoloGuestErrorV1('holo.generation_stale', 'device.events.acknowledgeResync', false)
    if (value == null || typeof value !== 'object' || Array.isArray(value)) throw invalidAck()
    const revisions = value as Readonly<Record<string, unknown>>
    for (const key of Object.keys(revisions)) {
      if (!DEVICE_EVENT_KINDS_V1.includes(key as DeviceEventKindV1)) throw invalidAck()
      const revision = revisions[key]
      if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw invalidAck()
      if ((revision as number) > (observedRevisions.get(key as DeviceEventKindV1) ?? -1)) throw invalidAck()
    }
    for (const [kind, requiredRevision] of requiredRevisions) {
      const revision = revisions[kind]
      if (typeof revision !== 'number' || revision < requiredRevision) throw invalidAck()
    }
    const buffered = [...coalesced.values()].sort((left, right) => left.kind.localeCompare(right.kind))
    requiredRevisions.clear()
    coalesced.clear()
    for (const event of buffered) {
      if (event.reading.revision > ((revisions[event.kind] as number | undefined) ?? -1)) deliverData(event)
    }
  }

  const close = async () => {
    if (closed) return
    closed = true
    queue.length = 0
    while (waiting.length > 0) waiting.shift()!(doneResult())
    await input.onClose()
  }
  const resource = Object.freeze({
    [Symbol.asyncIterator]() {
      return resource
    },
    acknowledgeResync,
    close,
    generation: input.generation,
    maxQueuedEvents: input.maxQueuedEvents,
    next(): Promise<IteratorResultV1> {
      if (queue.length > 0) return Promise.resolve(eventResult(queue.shift()!))
      if (closed) return Promise.resolve(doneResult())
      return new Promise(resolve => waiting.push(resolve))
    },
    return() {
      return close().then(doneResult)
    },
    startSequence: input.startSequence
  })
  return Object.freeze({ accept, resource })
}
