import type { DeviceReadingV1, DeviceValueMapV1, DeviceValueOperationV1, HoloDeviceSummaryV1 } from './device-types.js'
import { normalizeDeviceValue } from './device-value-normalizers.js'
import { invalidPolicy } from './errors.js'
import { deepFreeze, exact, finiteNumber, integer, literal, required } from './validation.js'

export const normalizeDeviceReadingV1 = <K extends DeviceValueOperationV1>(
  operation: K,
  value: unknown
): DeviceReadingV1<DeviceValueMapV1[K]> => {
  const input = exact(value, ['observedAt', 'precision', 'revision', 'status', 'value'])
  const status = literal(
    required(input, 'status'),
    ['available', 'permissionDenied', 'redacted', 'unavailable', 'unsupported'] as const
  )
  const common = {
    observedAt: finiteNumber(required(input, 'observedAt'), 0, Number.MAX_SAFE_INTEGER),
    revision: integer(required(input, 'revision'), 0, Number.MAX_SAFE_INTEGER),
    status
  }
  if (status === 'available') {
    const precision = literal(required(input, 'precision'), ['coarse', 'exact', 'standard'] as const)
    return deepFreeze({
      ...common,
      precision,
      value: normalizeDeviceValue(operation, required(input, 'value'))
    }) as DeviceReadingV1<DeviceValueMapV1[K]>
  }
  if (status === 'redacted') {
    if (required(input, 'precision') !== 'redacted') return invalidPolicy()
    return deepFreeze({
      ...common,
      precision: 'redacted',
      value: normalizeDeviceValue(operation, required(input, 'value'))
    }) as DeviceReadingV1<DeviceValueMapV1[K]>
  }
  if (Object.hasOwn(input, 'value') || required(input, 'precision') !== 'none') return invalidPolicy()
  return Object.freeze({ ...common, precision: 'none' }) as DeviceReadingV1<DeviceValueMapV1[K]>
}

export const normalizeDeviceSummaryV1 = (value: unknown): HoloDeviceSummaryV1 => {
  const input = exact(value, ['display', 'formFactor', 'input', 'lifecycle', 'power', 'schemaVersion'])
  if (required(input, 'schemaVersion') !== 1) return invalidPolicy()
  return deepFreeze({
    display: normalizeDeviceReadingV1('device.display.read', required(input, 'display')),
    formFactor: normalizeDeviceReadingV1('device.form-factor.read', required(input, 'formFactor')),
    input: normalizeDeviceReadingV1('device.input.read', required(input, 'input')),
    lifecycle: normalizeDeviceReadingV1('device.lifecycle.read', required(input, 'lifecycle')),
    power: normalizeDeviceReadingV1('device.power.read', required(input, 'power')),
    schemaVersion: 1
  })
}
