/* eslint-disable no-extend-native -- This scoped regression restores the original Object.prototype descriptor in finally. */
import { describe, expect, it } from 'vitest'

import type {
  DeviceEventBaseV1,
  DeviceReadingV1,
  DisplayV1,
  HoloDeviceEventV1
} from '../../../packages/capabilities/device/src/index.js'
import type { CapabilityGuestBridgeV1 } from '../../../packages/runtime/src/kernel/guest-facade-support.js'
import { createCapabilityModuleOverridesV1 } from '../../../packages/runtime/src/kernel/guest-facades.js'

type Reading = DeviceReadingV1<DisplayV1>
type Subscription = AsyncIterator<HoloDeviceEventV1> & {
  acknowledgeResync(revisions: { display: number }): Promise<void>
  close(): Promise<void>
}
const reading = (revision: number): Reading => ({
  observedAt: revision,
  precision: 'standard',
  revision,
  status: 'available',
  value: {
    hdr: 'unknown',
    heightCssPx: 900,
    orientation: 'landscape',
    scale: 2,
    wideColor: 'unknown',
    widthCssPx: 1400 + revision
  }
})
const setup = (rejectSubscription = false, rejectUnsubscribe = false) => {
  let listener: ((event: string) => void) | undefined
  let denied = false
  let releases = 0
  const terminal = () =>
    JSON.stringify(
      denied
        ? {
          ok: false,
          error: { code: 'holo.permission_denied', message: 'Denied', name: 'HoloError', retryable: false }
        }
        : { ok: true, value: reading(3) }
    )
  const bridge: CapabilityGuestBridgeV1 = {
    invokeSync: terminal,
    async invoke(request) {
      return JSON.parse(request).member === 'subscribe'
        ? JSON.stringify({
          ok: true,
          value: {
            binding: { bindingId: 'device-owned', generation: 1 },
            maxQueuedEvents: 1,
            resourceType: 'device.subscription',
            startSequence: 0
          }
        })
        : terminal()
    },
    releaseResource: () => {
      releases++
    },
    subscribeResource: (_id, callback) => {
      if (rejectSubscription) throw new Error('subscription transport rejected')
      listener = callback
      return () => {
        listener = undefined
        if (rejectUnsubscribe) throw new Error('unsubscribe transport rejected')
      }
    }
  }
  const modules = createCapabilityModuleOverridesV1({ context: {} }, bridge)
  const sync = (modules['holo:device'] as { namespace: { getDisplay(): Reading; getInput(): unknown } }).namespace
  const promises = (modules['holo:device/promises'] as {
    namespace: { getDisplay(): Promise<Reading>; subscribe(options: unknown): Promise<Subscription> }
  }).namespace
  return {
    sync,
    promises,
    deny: () => {
      denied = true
    },
    emit: (event: HoloDeviceEventV1) => listener?.(JSON.stringify(event)),
    releases: () => releases
  }
}
const overflow = (fixture: ReturnType<typeof setup>) =>
  fixture.emit({
    dropped: 1,
    kind: 'overflow',
    observedAt: 2,
    requiredRevisions: { display: 2 },
    resyncRequired: true,
    schemaVersion: 1,
    sequence: 2
  })
const event = (revision: number, sequence: number): DeviceEventBaseV1<'display'> => ({
  kind: 'display',
  observedAt: revision,
  phase: 'change',
  reading: reading(revision),
  schemaVersion: 1,
  sequence
})

describe('device resync independent reading knowledge', () => {
  it.each(['sync', 'promise'])('accepts an authorized %s getter newer than the delayed event', async mode => {
    const fixture = setup()
    const subscription = await fixture.promises.subscribe({ kinds: ['display'], maxQueuedEvents: 1 })
    fixture.emit(event(1, 1))
    await subscription.next()
    overflow(fixture)
    await subscription.next()
    await expect(subscription.acknowledgeResync({ display: 3 })).rejects.toMatchObject({
      code: 'holo.invalid_arguments'
    })
    const latest = mode === 'sync' ? fixture.sync.getDisplay() : await fixture.promises.getDisplay()
    expect(latest.revision).toBe(3)
    await expect(subscription.acknowledgeResync({ display: 4 })).rejects.toMatchObject({
      code: 'holo.invalid_arguments'
    })
    await expect(subscription.acknowledgeResync({ display: latest.revision })).resolves.toBeUndefined()
    fixture.emit(event(2, 3))
    fixture.emit(event(4, 4))
    await expect(subscription.next()).resolves.toMatchObject({ value: { reading: { revision: 4 } } })
    await subscription.close()
  })

  it('does not let a failed getter authorize a future acknowledgement', async () => {
    const fixture = setup()
    const subscription = await fixture.promises.subscribe({ kinds: ['display'], maxQueuedEvents: 1 })
    fixture.emit(event(1, 1))
    await subscription.next()
    overflow(fixture)
    await subscription.next()
    fixture.deny()
    expect(() => fixture.sync.getDisplay()).toThrow('Denied')
    await expect(fixture.promises.getDisplay()).rejects.toThrow('Denied')
    await expect(subscription.acknowledgeResync({ display: 3 })).rejects.toMatchObject({
      code: 'holo.invalid_arguments'
    })
    await subscription.close()
  })

  it('does not discard an initial snapshot merely because a getter ran first', async () => {
    const fixture = setup()
    const subscription = await fixture.promises.subscribe({ kinds: ['display'], maxQueuedEvents: 1 })
    fixture.sync.getDisplay()
    await expect(subscription.acknowledgeResync({ display: 3 })).rejects.toMatchObject({
      code: 'holo.invalid_arguments'
    })
    fixture.emit({ ...event(1, 1), phase: 'snapshot' })
    await expect(subscription.next()).resolves.toMatchObject({ value: { phase: 'snapshot', reading: { revision: 1 } } })
    await subscription.close()
  })

  it('does not learn another kind through Guest Object.prototype pollution', async () => {
    const fixture = setup()
    const subscription = await fixture.promises.subscribe({ kinds: ['display'], maxQueuedEvents: 1 })
    overflow(fixture)
    await subscription.next()
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'getInput')
    try {
      Object.defineProperty(Object.prototype, 'getInput', { configurable: true, value: 'display' })
      fixture.sync.getInput()
      await expect(subscription.acknowledgeResync({ display: 3 })).rejects.toMatchObject({
        code: 'holo.invalid_arguments'
      })
    } finally {
      if (previous == null) Reflect.deleteProperty(Object.prototype, 'getInput')
      else Object.defineProperty(Object.prototype, 'getInput', previous)
      await subscription.close()
    }
  })

  it('releases an admitted resource when native event subscription fails', async () => {
    const fixture = setup(true)
    await expect(fixture.promises.subscribe({ kinds: ['display'], maxQueuedEvents: 1 })).rejects.toThrow(
      'subscription transport rejected'
    )
    expect(fixture.releases()).toBe(1)
  })

  it('still releases the Host resource if event unsubscription throws', async () => {
    const fixture = setup(false, true)
    const subscription = await fixture.promises.subscribe({ kinds: ['display'], maxQueuedEvents: 1 })
    await expect(subscription.close()).rejects.toThrow('unsubscribe transport rejected')
    expect(fixture.releases()).toBe(1)
  })
})
