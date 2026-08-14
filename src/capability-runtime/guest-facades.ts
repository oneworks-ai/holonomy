import { createCapabilityChildProcessOverrideV1 } from './guest-child-process-facade.js'
import { childProcessEnvironmentV1 } from './guest-child-process-support.js'
import type { CapabilityGuestBridgeV1, CapabilityGuestConfigurationV1 } from './guest-facade-support.js'
import {
  capabilityResourceFieldsV1,
  createCapabilityRequestV1,
  createCapabilitySyntheticBindingV1,
  deepFreezeCapabilityValueV1,
  readCapabilityResourceEventV1,
  readCapabilityTerminalV1
} from './guest-facade-support.js'
import { createCapabilityFsModuleOverridesV1 } from './guest-fs-facade.js'
import { createCapabilityProcessOverrideV1 } from './guest-process-facade.js'
import type { JsonValueV1 } from './json-types.js'

export type { CapabilityGuestBridgeV1, CapabilityGuestConfigurationV1 } from './guest-facade-support.js'
export {
  createCapabilityFetchV1,
  createCapabilityNetworkHooksV1,
  createUnsupportedCapabilityWebSocketV1
} from './guest-fetch.js'

const SYSTEM_MEMBERS = Object.freeze([
  'arch',
  'availableParallelism',
  'cpus',
  'freemem',
  'homedir',
  'hostname',
  'loadavg',
  'machine',
  'networkInterfaces',
  'platform',
  'release',
  'tmpdir',
  'totalmem',
  'type',
  'uptime',
  'userInfo',
  'version'
])
const DEVICE_MEMBERS = Object.freeze([
  'getCellularState',
  'getConnectivity',
  'getDisplay',
  'getFormFactor',
  'getInput',
  'getLifecycle',
  'getMediaCapabilities',
  'getPower',
  'getSecurityCapabilities',
  'getSensorCapabilities',
  'getSummary',
  'getThermal',
  'getWifiState'
])

export const createCapabilityModuleOverridesV1 = (
  configuration: CapabilityGuestConfigurationV1,
  bridge: CapabilityGuestBridgeV1
): Readonly<Record<string, unknown>> => {
  const invokeSync = (module: string, member: string, value: JsonValueV1 = {}) =>
    readCapabilityTerminalV1(bridge.invokeSync(createCapabilityRequestV1(module, member, 'sync', value)))
  const invoke = async (module: string, member: string, value: JsonValueV1 = {}) =>
    readCapabilityTerminalV1(await bridge.invoke(createCapabilityRequestV1(module, member, 'promise', value)))
  const osDefault: Record<string, () => unknown> = Object.create(null) as Record<string, () => unknown>
  for (const member of SYSTEM_MEMBERS) {
    Object.defineProperty(osDefault, member, { enumerable: true, value: () => invokeSync('node:os', member) })
  }
  Object.freeze(osDefault)
  const deviceDefault: Record<string, () => unknown> = Object.create(null) as Record<string, () => unknown>
  const devicePromisesDefault: Record<string, () => Promise<unknown>> = Object.create(null) as Record<
    string,
    () => Promise<unknown>
  >
  for (const member of DEVICE_MEMBERS) {
    Object.defineProperty(deviceDefault, member, {
      enumerable: true,
      value: () => invokeSync('holo:device', member)
    })
    Object.defineProperty(devicePromisesDefault, member, {
      enumerable: true,
      value: () => invoke('holo:device/promises', member)
    })
  }
  Object.defineProperty(devicePromisesDefault, 'getWifiIdentity', {
    enumerable: true,
    value: () => invoke('holo:device/promises', 'getWifiIdentity')
  })
  Object.defineProperty(devicePromisesDefault, 'subscribe', {
    enumerable: true,
    value: async (options: unknown) => {
      if (options == null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('Device subscription options must be an object')
      }
      const source = options as { kinds?: unknown; maxQueuedEvents?: unknown }
      if (!Array.isArray(source.kinds)) throw new TypeError('Device subscription kinds are required')
      const snapshot = await invoke('holo:device/promises', 'subscribe', {
        kinds: [...source.kinds] as JsonValueV1,
        ...(source.maxQueuedEvents == null ? {} : { maxQueuedEvents: source.maxQueuedEvents as number })
      })
      const fields = capabilityResourceFieldsV1(snapshot, 'device.subscription')
      const queue: unknown[] = []
      const pending: Array<Readonly<{ resolve(value: unknown): void }>> = []
      let closed = false
      const dispose = bridge.subscribeResource?.(fields.bindingId, eventSource => {
        if (closed) return
        const event = readCapabilityResourceEventV1(eventSource)
        const waiter = pending.shift()
        if (waiter == null) queue.push(event)
        else waiter.resolve({ done: false, value: event })
      })
      const close = async () => {
        if (closed) return
        closed = true
        dispose?.()
        bridge.releaseResource?.(fields.bindingId)
        while (pending.length > 0) pending.shift()!.resolve({ done: true, value: undefined })
      }
      const resource = Object.freeze({
        [Symbol.asyncIterator]() {
          return resource
        },
        acknowledgeResync(_revisions: unknown) {
          return Promise.resolve()
        },
        close,
        generation: (snapshot as { binding: { generation: number } }).binding.generation,
        next() {
          if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() })
          if (closed) return Promise.resolve({ done: true, value: undefined })
          return new Promise(resolve => pending.push({ resolve }))
        },
        return() {
          return close().then(() => ({ done: true, value: undefined }))
        },
        startSequence: (snapshot as { startSequence: number }).startSequence
      })
      return resource
    }
  })
  Object.freeze(deviceDefault)
  Object.freeze(devicePromisesDefault)
  const runtimeContext = deepFreezeCapabilityValueV1(JSON.parse(JSON.stringify(configuration.context)) as JsonValueV1)
  const runtimeDefault = Object.freeze({
    childProcessEnvironment: childProcessEnvironmentV1,
    getContext: () => runtimeContext
  })
  const processOverride = createCapabilityProcessOverrideV1(configuration, bridge)
  const childProcess = createCapabilityChildProcessOverrideV1(bridge, configuration)
  return Object.freeze({
    ...(childProcess == null ? {} : { 'node:child_process': childProcess }),
    ...createCapabilityFsModuleOverridesV1(bridge),
    'holo:device': createCapabilitySyntheticBindingV1(
      { ...deviceDefault, default: deviceDefault },
      [...DEVICE_MEMBERS, 'default']
    ),
    'holo:device/promises': createCapabilitySyntheticBindingV1(
      { ...devicePromisesDefault, default: devicePromisesDefault },
      [...DEVICE_MEMBERS, 'getWifiIdentity', 'subscribe', 'default']
    ),
    'holo:runtime': createCapabilitySyntheticBindingV1({
      childProcessEnvironment: runtimeDefault.childProcessEnvironment,
      default: runtimeDefault,
      getContext: runtimeDefault.getContext
    }, ['childProcessEnvironment', 'getContext', 'default']),
    'node:os': createCapabilitySyntheticBindingV1(
      { ...osDefault, default: osDefault },
      [...SYSTEM_MEMBERS, 'default']
    ),
    ...(processOverride == null ? {} : { 'node:process': processOverride })
  })
}
