import { serviceError } from './errors.mjs'
import { touchResource, validateDeviceInput } from './registry-helpers.mjs'
import { cloneJson } from './validation.mjs'

export const refreshDevices = async (context, inputs) => {
  if (!Array.isArray(inputs) || inputs.length > 256) {
    throw serviceError('service.limit_exceeded', 'Device inventory exceeds its limit')
  }
  const now = context.now()
  const devices = inputs.map(input => validateDeviceInput(input, now))
  return await context.store.transact(
    result => ({ data: { count: result.length }, type: 'devices.refreshed' }),
    draft => {
      const observed = new Set(devices.map(device => device.id))
      for (const existing of Object.values(draft.resources.devices)) {
        if (!observed.has(existing.id) && existing.state !== 'disconnected') {
          existing.state = 'disconnected'
          touchResource(existing, now)
        }
      }
      for (const device of devices) {
        const existing = draft.resources.devices[device.id]
        draft.resources.devices[device.id] = {
          ...device,
          createdAt: existing?.createdAt ?? now,
          revision: (existing?.revision ?? 0) + 1,
          updatedAt: now
        }
      }
      return devices.map(device => cloneJson(draft.resources.devices[device.id]))
    }
  )
}
