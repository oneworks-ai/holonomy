import type { DeviceEventKindV1 } from '@holonomyjs/capability-device/kernel/device-types'
import { createGuestDeviceSubscriptionV1 } from '@holonomyjs/capability-device/kernel/guest-device-subscription'
import { createCapabilityFsModuleOverridesV1 } from '@holonomyjs/capability-fs/kernel/guest-fs-facade'
import { createCapabilityChildProcessOverrideV1 } from '@holonomyjs/capability-process/kernel/guest-child-process-facade'
import { childProcessEnvironmentV1 } from '@holonomyjs/capability-process/kernel/guest-child-process-support'
import { createCapabilityProcessOverrideV1 } from '@holonomyjs/capability-process/kernel/guest-process-facade'
import type { CapabilityGuestBridgeV1, CapabilityGuestConfigurationV1 } from './guest-facade-support.js'
import {
  capabilityResourceFieldsV1,
  createCapabilityRequestV1,
  createCapabilitySyntheticBindingV1,
  deepFreezeCapabilityValueV1,
  readCapabilityResourceEventV1,
  readCapabilityTerminalV1
} from './guest-facade-support.js'
import type { JsonValueV1 } from './json-types.js'

/* eslint-disable perfectionist/sort-exports -- dprint owns mixed package/relative export order. */
export {
  createCapabilityFetchV1,
  createCapabilityNetworkHooksV1,
  createUnsupportedCapabilityWebSocketV1
} from '@holonomyjs/capability-network/kernel/guest-fetch'
export type { CapabilityGuestBridgeV1, CapabilityGuestConfigurationV1 } from './guest-facade-support.js'
/* eslint-enable perfectionist/sort-exports */

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
      const resourceSnapshot = snapshot as {
        binding: { generation: number }
        maxQueuedEvents: number
        startSequence: number
      }
      let dispose: (() => void) | undefined
      const controller = createGuestDeviceSubscriptionV1({
        generation: resourceSnapshot.binding.generation,
        kinds: source.kinds as DeviceEventKindV1[],
        maxQueuedEvents: resourceSnapshot.maxQueuedEvents,
        onClose: () => {
          dispose?.()
          bridge.releaseResource?.(fields.bindingId)
        },
        startSequence: resourceSnapshot.startSequence
      })
      dispose = bridge.subscribeResource?.(fields.bindingId, eventSource => {
        controller.accept(readCapabilityResourceEventV1(eventSource))
      })
      return controller.resource
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
