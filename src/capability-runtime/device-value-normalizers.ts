import type { DeviceValueMapV1, DeviceValueOperationV1 } from './device-types.js'
import { invalidPolicy } from './errors.js'
import { boolean, boundedText, exact, finiteNumber, integer, literal, required, stringSet } from './validation.js'

const unknownBoolean = (value: unknown) =>
  typeof value === 'boolean'
    ? value
    : literal(value, ['unknown'] as const)
const percent = (value: unknown) => integer(value, 0, 100)

const connectivity = (value: unknown) => {
  const input = exact(value, ['captivePortal', 'metered', 'online', 'quality', 'roaming', 'transports', 'validated'])
  return Object.freeze({
    captivePortal: unknownBoolean(required(input, 'captivePortal')),
    metered: unknownBoolean(required(input, 'metered')),
    online: boolean(required(input, 'online')),
    quality: literal(required(input, 'quality'), ['excellent', 'fair', 'good', 'offline', 'poor', 'unknown'] as const),
    roaming: unknownBoolean(required(input, 'roaming')),
    transports: stringSet(
      required(input, 'transports'),
      ['bluetooth', 'cellular', 'ethernet', 'other', 'vpn', 'wifi'] as const,
      0,
      6
    ),
    validated: boolean(required(input, 'validated'))
  })
}

const connected = (value: unknown, cellular: boolean) => {
  const input = exact(value, cellular ? ['connected', 'radio', 'signalPercent'] : ['connected', 'signalPercent'])
  const isConnected = boolean(required(input, 'connected'))
  if (!isConnected && Object.hasOwn(input, 'signalPercent')) return invalidPolicy()
  const signal = Object.hasOwn(input, 'signalPercent') ? { signalPercent: percent(input.signalPercent) } : {}
  if (!cellular) return Object.freeze({ connected: isConnected, ...signal })
  const radio = literal(required(input, 'radio'), ['2g', '3g', '4g', '5g', 'other', 'unknown'] as const)
  if (!isConnected && radio !== 'unknown') return invalidPolicy()
  return Object.freeze({ connected: isConnected, radio, ...signal })
}

const power = (value: unknown) => {
  const input = exact(value, ['charging', 'hasBattery', 'levelPercent', 'lowPowerMode', 'source'])
  const hasBattery = boolean(required(input, 'hasBattery'))
  const charging = unknownBoolean(required(input, 'charging'))
  const source = literal(required(input, 'source'), ['ac', 'battery', 'unknown', 'usb', 'wireless'] as const)
  if (!hasBattery && (Object.hasOwn(input, 'levelPercent') || charging !== false || source === 'battery')) {
    return invalidPolicy()
  }
  return Object.freeze({
    charging,
    hasBattery,
    ...(Object.hasOwn(input, 'levelPercent') ? { levelPercent: percent(input.levelPercent) } : {}),
    lowPowerMode: unknownBoolean(required(input, 'lowPowerMode')),
    source
  })
}

const display = (value: unknown) => {
  const input = exact(value, ['hdr', 'heightCssPx', 'orientation', 'refreshRateHz', 'scale', 'wideColor', 'widthCssPx'])
  return Object.freeze({
    hdr: unknownBoolean(required(input, 'hdr')),
    heightCssPx: integer(required(input, 'heightCssPx'), 1, 1_000_000),
    orientation: literal(required(input, 'orientation'), ['landscape', 'portrait', 'unknown'] as const),
    ...(Object.hasOwn(input, 'refreshRateHz') ? { refreshRateHz: finiteNumber(input.refreshRateHz, 1, 1000) } : {}),
    scale: finiteNumber(required(input, 'scale'), 0.25, 16),
    wideColor: unknownBoolean(required(input, 'wideColor')),
    widthCssPx: integer(required(input, 'widthCssPx'), 1, 1_000_000)
  })
}

const inputValue = (value: unknown) => {
  const input = exact(value, ['hover', 'keyboard', 'maxTouchPoints', 'mouse', 'pointer', 'touch'])
  const touch = boolean(required(input, 'touch'))
  const maxTouchPoints = integer(required(input, 'maxTouchPoints'), 0, 64)
  if ((touch && maxTouchPoints === 0) || (!touch && maxTouchPoints !== 0)) return invalidPolicy()
  return Object.freeze({
    hover: boolean(required(input, 'hover')),
    keyboard: boolean(required(input, 'keyboard')),
    maxTouchPoints,
    mouse: boolean(required(input, 'mouse')),
    pointer: literal(required(input, 'pointer'), ['coarse', 'fine', 'none'] as const),
    touch
  })
}

const booleans = (value: unknown, keys: readonly string[]) => {
  const input = exact(value, keys)
  return Object.freeze(Object.fromEntries(keys.map(key => [key, boolean(required(input, key))])))
}

export const normalizeDeviceValue = <K extends DeviceValueOperationV1>(
  operation: K,
  value: unknown
): DeviceValueMapV1[K] => {
  let output: unknown
  switch (operation) {
    case 'device.form-factor.read':
      output = literal(
        value,
        ['automotive', 'desktop', 'phone', 'server', 'tablet', 'tv', 'unknown', 'wearable'] as const
      )
      break
    case 'device.connectivity.read':
      output = connectivity(value)
      break
    case 'device.connectivity.wifi.state.read':
      output = connected(value, false)
      break
    case 'device.connectivity.cellular.state.read':
      output = connected(value, true)
      break
    case 'device.connectivity.wifi.identity.read': {
      const input = exact(value, ['bssid', 'ssid'])
      if (!Object.hasOwn(input, 'bssid') && !Object.hasOwn(input, 'ssid')) return invalidPolicy()
      const bssid = Object.hasOwn(input, 'bssid') ? boundedText(input.bssid, 17).toLowerCase() : undefined
      if (bssid !== undefined && !/^(?:[\da-f]{2}:){5}[\da-f]{2}$/u.test(bssid)) return invalidPolicy()
      output = Object.freeze({
        ...(bssid === undefined ? {} : { bssid }),
        ...(Object.hasOwn(input, 'ssid') ? { ssid: boundedText(input.ssid, 256) } : {})
      })
      break
    }
    case 'device.power.read':
      output = power(value)
      break
    case 'device.display.read':
      output = display(value)
      break
    case 'device.input.read':
      output = inputValue(value)
      break
    case 'device.thermal.read': {
      const input = exact(value, ['state'])
      output = Object.freeze({
        state: literal(required(input, 'state'), ['critical', 'fair', 'nominal', 'serious', 'unknown'] as const)
      })
      break
    }
    case 'device.media.capabilities.read':
      output = booleans(value, ['camera', 'microphone', 'speaker'])
      break
    case 'device.sensor.capabilities.read': {
      const input = exact(value, ['available'])
      output = Object.freeze({
        available: stringSet(
          required(input, 'available'),
          ['accelerometer', 'barometer', 'gyroscope', 'light', 'magnetometer', 'proximity'] as const,
          0,
          6
        )
      })
      break
    }
    case 'device.security.capabilities.read': {
      const input = exact(value, ['biometric', 'deviceLock', 'hardwareBackedKeys', 'secureStorage'])
      output = Object.freeze({
        biometric: unknownBoolean(required(input, 'biometric')),
        deviceLock: unknownBoolean(required(input, 'deviceLock')),
        hardwareBackedKeys: unknownBoolean(required(input, 'hardwareBackedKeys')),
        secureStorage: boolean(required(input, 'secureStorage'))
      })
      break
    }
    case 'device.lifecycle.read': {
      const input = exact(value, ['interactive', 'memoryPressure', 'visibility'])
      output = Object.freeze({
        interactive: unknownBoolean(required(input, 'interactive')),
        memoryPressure: literal(
          required(input, 'memoryPressure'),
          ['critical', 'moderate', 'normal', 'unknown'] as const
        ),
        visibility: literal(required(input, 'visibility'), ['background', 'foreground', 'unknown'] as const)
      })
      break
    }
    default:
      return invalidPolicy()
  }
  return output as DeviceValueMapV1[K]
}
