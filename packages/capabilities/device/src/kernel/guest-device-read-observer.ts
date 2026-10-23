import type { DeviceEventKindV1 } from './device-types.js'
import type { GuestDeviceSubscriptionControllerV1 } from './guest-device-subscription.js'

const EVENT_GETTERS: Readonly<Record<string, DeviceEventKindV1>> = Object.freeze(Object.assign(
  Object.create(null) as Record<string, DeviceEventKindV1>,
  {
    getConnectivity: 'connectivity',
    getDisplay: 'display',
    getLifecycle: 'lifecycle',
    getPower: 'power',
    getThermal: 'thermal'
  }
))

/** Per-facade read observations only; the Provider remains the revision owner. */
export const createGuestDeviceReadObserverV1 = () => {
  const subscriptions = new Set<GuestDeviceSubscriptionControllerV1>()
  return Object.freeze({
    add: (controller: GuestDeviceSubscriptionControllerV1) => subscriptions.add(controller),
    remove: (controller: GuestDeviceSubscriptionControllerV1) => subscriptions.delete(controller),
    observe(member: string, value: unknown) {
      const kind = EVENT_GETTERS[member]
      if (kind == null || value == null || typeof value !== 'object') return
      const revision = (value as { revision?: unknown }).revision
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return
      for (const subscription of subscriptions) subscription.observeRead(kind, revision)
    }
  })
}
