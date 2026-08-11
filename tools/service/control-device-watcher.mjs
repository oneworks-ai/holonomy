import { DeviceWatcher } from './device-watcher.mjs'

export const createControlDeviceWatcher = options =>
  new DeviceWatcher({
    adapter: options.adapters,
    commit: async (devices, context) => {
      if (context.signal.aborted) return devices
      const refreshed = await options.registry.refreshDevices(devices)
      if (!context.signal.aborted) await options.reconciler.devices(refreshed, context)
      return refreshed
    },
    intervalMs: options.intervalMs,
    now: options.now
  })
