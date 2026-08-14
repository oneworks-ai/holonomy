# RFC-0001 附录 D.2：`holo:device` v1 值类型

[返回 Device Schema](device-schema-v1.md)

```ts
interface ConnectivityV1 {
  readonly online: boolean
  readonly validated: boolean
  readonly transports: readonly (
    | 'wifi'
    | 'cellular'
    | 'ethernet'
    | 'vpn'
    | 'bluetooth'
    | 'other'
  )[]
  readonly metered: boolean | 'unknown'
  readonly roaming: boolean | 'unknown'
  readonly captivePortal: boolean | 'unknown'
  readonly quality:
    | 'offline'
    | 'poor'
    | 'fair'
    | 'good'
    | 'excellent'
    | 'unknown'
}
interface WifiStateV1 {
  readonly connected: boolean
  readonly signalPercent?: number
}
interface WifiIdentityV1 {
  readonly ssid?: string
  readonly bssid?: string
}
interface CellularStateV1 {
  readonly connected: boolean
  readonly signalPercent?: number
  readonly radio: '2g' | '3g' | '4g' | '5g' | 'other' | 'unknown'
}
interface PowerV1 {
  readonly hasBattery: boolean
  readonly levelPercent?: number
  readonly charging: boolean | 'unknown'
  readonly source: 'battery' | 'ac' | 'usb' | 'wireless' | 'unknown'
  readonly lowPowerMode: boolean | 'unknown'
}
interface DisplayV1 {
  readonly widthCssPx: number
  readonly heightCssPx: number
  readonly scale: number
  readonly refreshRateHz?: number
  readonly orientation: 'portrait' | 'landscape' | 'unknown'
  readonly hdr: boolean | 'unknown'
  readonly wideColor: boolean | 'unknown'
}
interface InputV1 {
  readonly touch: boolean
  readonly maxTouchPoints: number
  readonly pointer: 'none' | 'coarse' | 'fine'
  readonly hover: boolean
  readonly keyboard: boolean
  readonly mouse: boolean
}
interface ThermalV1 {
  readonly state: 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown'
}
interface MediaCapabilitiesV1 {
  readonly camera: boolean
  readonly microphone: boolean
  readonly speaker: boolean
}
interface SensorCapabilitiesV1 {
  readonly available: readonly (
    | 'accelerometer'
    | 'gyroscope'
    | 'barometer'
    | 'light'
    | 'proximity'
    | 'magnetometer'
  )[]
}
interface SecurityCapabilitiesV1 {
  readonly secureStorage: boolean
  readonly hardwareBackedKeys: boolean | 'unknown'
  readonly biometric: boolean | 'unknown'
  readonly deviceLock: boolean | 'unknown'
}
interface LifecycleV1 {
  readonly visibility: 'foreground' | 'background' | 'unknown'
  readonly interactive: boolean | 'unknown'
  readonly memoryPressure: 'normal' | 'moderate' | 'critical' | 'unknown'
}

interface HoloDeviceSummaryV1 {
  readonly schemaVersion: 1
  readonly formFactor: DeviceReadingV1<FormFactorV1>
  readonly power: DeviceReadingV1<PowerV1>
  readonly display: DeviceReadingV1<DisplayV1>
  readonly input: DeviceReadingV1<InputV1>
  readonly lifecycle: DeviceReadingV1<LifecycleV1>
}
```

百分比范围为整数 0–100；尺寸单位 CSS px；刷新率 Hz；所有数组去重、排序、有界。信号默认只给百分比 bucket，不暴露 dBm。Summary 只含 Tier 0/1；connectivity、thermal、media、sensors、security 必须独立读取。BSSID 规范为小写冒号分隔，SSID 是有界 UTF-8；两者均为 Tier 3，错误与日志不得回显。
