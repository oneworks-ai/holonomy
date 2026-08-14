import type {
  DeviceEventKindV1,
  DeviceProviderDescriptorV1,
  DeviceProviderOperationDescriptorV1,
  DeviceProviderTargetV1
} from './device-types.js'
import { invalidPolicy } from './errors.js'
import { DEVICE_OPERATIONS_V1 } from './registry-types.js'
import type { DeviceOperationV1 } from './registry-types.js'
import { array, deepFreeze, exact, literal, required, string, stringSet } from './validation.js'

export const DEVICE_EVENT_KINDS_V1 = Object.freeze(
  [
    'connectivity',
    'display',
    'lifecycle',
    'power',
    'thermal'
  ] as const satisfies readonly DeviceEventKindV1[]
)

const operationSet = (...values: DeviceOperationV1[]): readonly DeviceOperationV1[] => Object.freeze(values)
const eventSet = (...values: DeviceEventKindV1[]): readonly DeviceEventKindV1[] => Object.freeze(values)

const REQUIRED = Object.freeze({
  android: operationSet(
    'device.connectivity.cellular.state.read',
    'device.connectivity.read',
    'device.connectivity.wifi.state.read',
    'device.display.read',
    'device.events.subscribe',
    'device.form-factor.read',
    'device.input.read',
    'device.lifecycle.read',
    'device.power.read',
    'device.summary.read'
  ),
  desktop: operationSet(
    'device.display.read',
    'device.events.subscribe',
    'device.form-factor.read',
    'device.input.read',
    'device.lifecycle.read',
    'device.summary.read'
  ),
  node: operationSet(
    'device.form-factor.read',
    'device.lifecycle.read',
    'device.summary.read'
  )
}) satisfies Readonly<Record<DeviceProviderTargetV1, readonly DeviceOperationV1[]>>

const REQUIRED_EVENTS = Object.freeze({
  android: eventSet('connectivity', 'display', 'lifecycle', 'power'),
  desktop: eventSet('display', 'lifecycle'),
  node: eventSet()
}) satisfies Readonly<Record<DeviceProviderTargetV1, readonly DeviceEventKindV1[]>>

const normalizeOperation = (value: unknown): DeviceProviderOperationDescriptorV1 => {
  const input = exact(value, [
    'eventKinds',
    'maxPrecision',
    'operation',
    'permissionModel',
    'supportLevel'
  ])
  const operation = literal(required(input, 'operation'), DEVICE_OPERATIONS_V1)
  const supportLevel = literal(required(input, 'supportLevel'), ['optional', 'required', 'unsupported'] as const)
  const eventKinds = stringSet(required(input, 'eventKinds'), DEVICE_EVENT_KINDS_V1, 0, 5)
  if (operation !== 'device.events.subscribe' && eventKinds.length > 0) return invalidPolicy()
  if (supportLevel === 'unsupported') {
    if (
      required(input, 'permissionModel') !== 'none' ||
      required(input, 'maxPrecision') !== 'none' || eventKinds.length > 0
    ) return invalidPolicy()
    return Object.freeze({ eventKinds, maxPrecision: 'none', operation, permissionModel: 'none', supportLevel })
  }
  return Object.freeze({
    eventKinds,
    maxPrecision: literal(required(input, 'maxPrecision'), ['coarse', 'exact', 'redacted', 'standard'] as const),
    operation,
    permissionModel: literal(
      required(input, 'permissionModel'),
      ['host', 'hostAndPlatform', 'none', 'platform'] as const
    ),
    supportLevel
  })
}

export const compileDeviceProviderDescriptorV1 = (value: unknown): DeviceProviderDescriptorV1 => {
  const input = exact(value, ['operations', 'providerVersion', 'schemaVersion', 'target'])
  if (required(input, 'schemaVersion') !== 1) return invalidPolicy()
  const target = literal(required(input, 'target'), ['android', 'desktop', 'node'] as const)
  const operations = array(required(input, 'operations'), DEVICE_OPERATIONS_V1.length, DEVICE_OPERATIONS_V1.length)
    .map(normalizeOperation)
  if (new Set(operations.map(item => item.operation)).size !== DEVICE_OPERATIONS_V1.length) return invalidPolicy()
  operations.sort((left, right) => left.operation < right.operation ? -1 : 1)
  if (operations.some((item, index) => item.operation !== DEVICE_OPERATIONS_V1[index])) return invalidPolicy()
  const requiredSet = new Set(REQUIRED[target])
  for (const item of operations) {
    if (requiredSet.has(item.operation) !== (item.supportLevel === 'required')) return invalidPolicy()
    if (target === 'node' && !requiredSet.has(item.operation) && item.supportLevel !== 'unsupported') {
      return invalidPolicy()
    }
  }
  const subscription = operations.find(item => item.operation === 'device.events.subscribe')!
  if (subscription.eventKinds.join('\0') !== REQUIRED_EVENTS[target].join('\0')) return invalidPolicy()
  for (const event of subscription.eventKinds) {
    const operation = event === 'connectivity'
      ? 'device.connectivity.read'
      : `device.${event}.read` as DeviceOperationV1
    if (operations.find(item => item.operation === operation)?.supportLevel === 'unsupported') return invalidPolicy()
  }
  return deepFreeze({
    operations,
    providerVersion: string(required(input, 'providerVersion'), 64),
    schemaVersion: 1,
    target
  })
}

export const DEVICE_PROVIDER_REQUIRED_OPERATIONS_V1 = REQUIRED
export const DEVICE_PROVIDER_REQUIRED_EVENTS_V1 = REQUIRED_EVENTS
