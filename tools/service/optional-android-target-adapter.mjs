import { loadEmulatorOwners } from './android-emulator-support.mjs'
import { createAndroidRuntimeAdapter } from './android-target-adapter.mjs'
import { serviceError } from './errors.mjs'

const OPERATIONS = [
  'applyNetworkRules',
  'closeInspector',
  'exposeFixture',
  'openInspector',
  'readLogs',
  'reconcileProcess',
  'removeNetworkRules',
  'removeProcess',
  'restartEmulator',
  'resumeProcess',
  'startEmulator',
  'startProcess',
  'stopEmulator',
  'stopProcess',
  'subscribeProcess'
]

const unavailable = () => serviceError('service.unsupported', 'Android SDK and ADB are unavailable')

export const createOptionalAndroidRuntimeAdapter = (options = {}) => {
  const createAdapter = options.createAdapter ?? (() => createAndroidRuntimeAdapter(options))
  let adapter
  const load = () => {
    try {
      adapter ??= createAdapter()
      return adapter
    } catch {
      adapter = undefined
      throw unavailable()
    }
  }
  const optional = {
    target: 'android',
    async close() {
      await adapter?.close({})
      adapter = undefined
    },
    async listDevices(input) {
      try {
        return await load().listDevices(input)
      } catch {
        adapter = undefined
        return []
      }
    },
    async listEmulators(input) {
      try {
        return await load().listEmulators(input)
      } catch (error) {
        adapter = undefined
        if (error?.code !== 'service.unsupported') throw error
        const owners = await loadEmulatorOwners(options.emulatorStateFile)
        return [...owners.entries()].map(([id, owner]) => ({
          id,
          managed: true,
          ownerNonce: owner.ownerNonce,
          serial: owner.serial,
          state: 'running',
          verified: false
        }))
      }
    }
  }
  for (const operation of OPERATIONS) {
    optional[operation] = async input => await load()[operation](input)
  }
  return Object.freeze(optional)
}
