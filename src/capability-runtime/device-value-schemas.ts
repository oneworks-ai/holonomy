import type { JsonSchema } from './schema-primitives.js'
import { integerSchema, strictObject, stringSetSchema } from './schema-primitives.js'

const unknownBoolean: JsonSchema = { enum: [false, true, 'unknown'] }
const booleanSchema: JsonSchema = { type: 'boolean' }
const percent = integerSchema(0, 100)

const connected = (cellular: boolean): JsonSchema => ({
  allOf: [
    strictObject({
      connected: booleanSchema,
      ...(cellular
        ? { radio: { enum: ['2g', '3g', '4g', '5g', 'other', 'unknown'] } }
        : {}),
      signalPercent: percent
    }, cellular ? ['connected', 'radio'] : ['connected']),
    {
      if: {
        properties: { connected: { const: false } },
        required: ['connected'],
        type: 'object'
      },
      then: {
        not: { required: ['signalPercent'] },
        ...(cellular ? { properties: { radio: { const: 'unknown' } } } : {}),
        type: 'object'
      }
    }
  ]
})

const power: JsonSchema = {
  allOf: [
    strictObject({
      charging: unknownBoolean,
      hasBattery: booleanSchema,
      levelPercent: percent,
      lowPowerMode: unknownBoolean,
      source: { enum: ['ac', 'battery', 'unknown', 'usb', 'wireless'] }
    }, ['charging', 'hasBattery', 'lowPowerMode', 'source']),
    {
      if: {
        properties: { hasBattery: { const: false } },
        required: ['hasBattery'],
        type: 'object'
      },
      then: {
        not: {
          anyOf: [
            { required: ['levelPercent'], type: 'object' },
            {
              properties: { charging: { enum: [true, 'unknown'] } },
              required: ['charging'],
              type: 'object'
            },
            {
              properties: { source: { const: 'battery' } },
              required: ['source'],
              type: 'object'
            }
          ]
        },
        type: 'object'
      }
    }
  ]
}

const input: JsonSchema = {
  allOf: [
    strictObject({
      hover: booleanSchema,
      keyboard: booleanSchema,
      maxTouchPoints: integerSchema(0, 64),
      mouse: booleanSchema,
      pointer: { enum: ['coarse', 'fine', 'none'] },
      touch: booleanSchema
    }),
    {
      if: {
        properties: { touch: { const: true } },
        required: ['touch'],
        type: 'object'
      },
      then: { properties: { maxTouchPoints: integerSchema(1, 64) }, type: 'object' },
      else: { properties: { maxTouchPoints: { const: 0 } }, type: 'object' }
    }
  ]
}

export const DEVICE_VALUE_SCHEMAS_V1: Readonly<Record<string, JsonSchema>> = Object.freeze({
  'device.connectivity.cellular.state.read': connected(true),
  'device.connectivity.read': strictObject({
    captivePortal: unknownBoolean,
    metered: unknownBoolean,
    online: booleanSchema,
    quality: { enum: ['excellent', 'fair', 'good', 'offline', 'poor', 'unknown'] },
    roaming: unknownBoolean,
    transports: stringSetSchema({ enum: ['bluetooth', 'cellular', 'ethernet', 'other', 'vpn', 'wifi'] }, 0, 6),
    validated: booleanSchema
  }),
  'device.connectivity.wifi.identity.read': {
    anyOf: [
      { properties: { bssid: {} }, required: ['bssid'], type: 'object' },
      { properties: { ssid: {} }, required: ['ssid'], type: 'object' }
    ],
    ...strictObject({
      bssid: { pattern: '^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$', type: 'string' },
      ssid: { maxLength: 256, minLength: 1, type: 'string' }
    }, [])
  },
  'device.connectivity.wifi.state.read': connected(false),
  'device.display.read': strictObject({
    hdr: unknownBoolean,
    heightCssPx: integerSchema(1, 1_000_000),
    orientation: { enum: ['landscape', 'portrait', 'unknown'] },
    refreshRateHz: { maximum: 1000, minimum: 1, type: 'number' },
    scale: { maximum: 16, minimum: 0.25, type: 'number' },
    wideColor: unknownBoolean,
    widthCssPx: integerSchema(1, 1_000_000)
  }, ['hdr', 'heightCssPx', 'orientation', 'scale', 'wideColor', 'widthCssPx']),
  'device.form-factor.read': {
    enum: ['automotive', 'desktop', 'phone', 'server', 'tablet', 'tv', 'unknown', 'wearable']
  },
  'device.input.read': input,
  'device.lifecycle.read': strictObject({
    interactive: unknownBoolean,
    memoryPressure: { enum: ['critical', 'moderate', 'normal', 'unknown'] },
    visibility: { enum: ['background', 'foreground', 'unknown'] }
  }),
  'device.media.capabilities.read': strictObject({
    camera: booleanSchema,
    microphone: booleanSchema,
    speaker: booleanSchema
  }),
  'device.power.read': power,
  'device.security.capabilities.read': strictObject({
    biometric: unknownBoolean,
    deviceLock: unknownBoolean,
    hardwareBackedKeys: unknownBoolean,
    secureStorage: booleanSchema
  }),
  'device.sensor.capabilities.read': strictObject({
    available: stringSetSchema(
      {
        enum: ['accelerometer', 'barometer', 'gyroscope', 'light', 'magnetometer', 'proximity']
      },
      0,
      6
    )
  }),
  'device.thermal.read': strictObject({
    state: { enum: ['critical', 'fair', 'nominal', 'serious', 'unknown'] }
  })
})
