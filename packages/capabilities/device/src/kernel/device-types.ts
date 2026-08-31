import type { DeviceOperationV1 } from '@holonomyjs/runtime/kernel/registry-types'

export type FormFactorV1 = 'automotive' | 'desktop' | 'phone' | 'server' | 'tablet' | 'tv' | 'unknown' | 'wearable'

export interface ConnectivityV1 {
  readonly captivePortal: boolean | 'unknown'
  readonly metered: boolean | 'unknown'
  readonly online: boolean
  readonly quality: 'excellent' | 'fair' | 'good' | 'offline' | 'poor' | 'unknown'
  readonly roaming: boolean | 'unknown'
  readonly transports: readonly ('bluetooth' | 'cellular' | 'ethernet' | 'other' | 'vpn' | 'wifi')[]
  readonly validated: boolean
}
export interface WifiStateV1 {
  readonly connected: boolean
  readonly signalPercent?: number
}
export interface WifiIdentityV1 {
  readonly bssid?: string
  readonly ssid?: string
}
export interface CellularStateV1 {
  readonly connected: boolean
  readonly radio: '2g' | '3g' | '4g' | '5g' | 'other' | 'unknown'
  readonly signalPercent?: number
}
export interface PowerV1 {
  readonly charging: boolean | 'unknown'
  readonly hasBattery: boolean
  readonly levelPercent?: number
  readonly lowPowerMode: boolean | 'unknown'
  readonly source: 'ac' | 'battery' | 'unknown' | 'usb' | 'wireless'
}
export interface DisplayV1 {
  readonly hdr: boolean | 'unknown'
  readonly heightCssPx: number
  readonly orientation: 'landscape' | 'portrait' | 'unknown'
  readonly refreshRateHz?: number
  readonly scale: number
  readonly wideColor: boolean | 'unknown'
  readonly widthCssPx: number
}
export interface InputV1 {
  readonly hover: boolean
  readonly keyboard: boolean
  readonly maxTouchPoints: number
  readonly mouse: boolean
  readonly pointer: 'coarse' | 'fine' | 'none'
  readonly touch: boolean
}
export interface ThermalV1 {
  readonly state: 'critical' | 'fair' | 'nominal' | 'serious' | 'unknown'
}
export interface MediaCapabilitiesV1 {
  readonly camera: boolean
  readonly microphone: boolean
  readonly speaker: boolean
}
export interface SensorCapabilitiesV1 {
  readonly available: readonly ('accelerometer' | 'barometer' | 'gyroscope' | 'light' | 'magnetometer' | 'proximity')[]
}
export interface SecurityCapabilitiesV1 {
  readonly biometric: boolean | 'unknown'
  readonly deviceLock: boolean | 'unknown'
  readonly hardwareBackedKeys: boolean | 'unknown'
  readonly secureStorage: boolean
}
export interface LifecycleV1 {
  readonly interactive: boolean | 'unknown'
  readonly memoryPressure: 'critical' | 'moderate' | 'normal' | 'unknown'
  readonly visibility: 'background' | 'foreground' | 'unknown'
}

export type DeviceReadingV1<T> =
  | Readonly<
    {
      observedAt: number
      precision: 'coarse' | 'exact' | 'standard'
      revision: number
      status: 'available'
      value: Readonly<T>
    }
  >
  | Readonly<{ observedAt: number; precision: 'redacted'; revision: number; status: 'redacted'; value: Readonly<T> }>
  | Readonly<
    {
      observedAt: number
      precision: 'none'
      revision: number
      status: 'permissionDenied' | 'unavailable' | 'unsupported'
    }
  >

export interface DeviceValueMapV1 {
  readonly 'device.connectivity.cellular.state.read': CellularStateV1
  readonly 'device.connectivity.read': ConnectivityV1
  readonly 'device.connectivity.wifi.identity.read': WifiIdentityV1
  readonly 'device.connectivity.wifi.state.read': WifiStateV1
  readonly 'device.display.read': DisplayV1
  readonly 'device.form-factor.read': FormFactorV1
  readonly 'device.input.read': InputV1
  readonly 'device.lifecycle.read': LifecycleV1
  readonly 'device.media.capabilities.read': MediaCapabilitiesV1
  readonly 'device.power.read': PowerV1
  readonly 'device.security.capabilities.read': SecurityCapabilitiesV1
  readonly 'device.sensor.capabilities.read': SensorCapabilitiesV1
  readonly 'device.thermal.read': ThermalV1
}
export type DeviceValueOperationV1 = keyof DeviceValueMapV1

export interface HoloDeviceSummaryV1 {
  readonly display: DeviceReadingV1<DisplayV1>
  readonly formFactor: DeviceReadingV1<FormFactorV1>
  readonly input: DeviceReadingV1<InputV1>
  readonly lifecycle: DeviceReadingV1<LifecycleV1>
  readonly power: DeviceReadingV1<PowerV1>
  readonly schemaVersion: 1
}

export type DeviceEventKindV1 = 'connectivity' | 'display' | 'lifecycle' | 'power' | 'thermal'
export type DeviceProviderTargetV1 = 'android' | 'desktop' | 'node'
export interface DeviceProviderOperationDescriptorV1 {
  readonly eventKinds: readonly DeviceEventKindV1[]
  readonly maxPrecision: 'coarse' | 'exact' | 'none' | 'redacted' | 'standard'
  readonly operation: DeviceOperationV1
  readonly permissionModel: 'host' | 'hostAndPlatform' | 'none' | 'platform'
  readonly supportLevel: 'optional' | 'required' | 'unsupported'
}
export interface DeviceProviderDescriptorV1 {
  readonly operations: readonly DeviceProviderOperationDescriptorV1[]
  readonly providerVersion: string
  readonly schemaVersion: 1
  readonly target: DeviceProviderTargetV1
}
