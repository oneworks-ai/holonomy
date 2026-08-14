# RFC-0001 附录 D：`holo:device` v1 Schema

[返回 RFC 总览](../0001-holo-capability-runtime.md)

本附录冻结 v1 公共形状。实现不得按平台返回不同字段名、单位或错误语义。

## D.1 公共入口

`holo:device` 提供同步 snapshot reads；`holo:device/promises` 提供同名 Promise 入口，并额外提供高敏读取和订阅：

```ts
interface HoloDeviceSyncV1 {
  getSummary(): HoloDeviceSummaryV1
  getFormFactor(): DeviceReadingV1<FormFactorV1>
  getConnectivity(): DeviceReadingV1<ConnectivityV1>
  getWifiState(): DeviceReadingV1<WifiStateV1>
  getCellularState(): DeviceReadingV1<CellularStateV1>
  getPower(): DeviceReadingV1<PowerV1>
  getDisplay(): DeviceReadingV1<DisplayV1>
  getInput(): DeviceReadingV1<InputV1>
  getThermal(): DeviceReadingV1<ThermalV1>
  getMediaCapabilities(): DeviceReadingV1<MediaCapabilitiesV1>
  getSensorCapabilities(): DeviceReadingV1<SensorCapabilitiesV1>
  getSecurityCapabilities(): DeviceReadingV1<SecurityCapabilitiesV1>
  getLifecycle(): DeviceReadingV1<LifecycleV1>
}

type PromisifyDeviceSyncV1 = {
  [K in keyof HoloDeviceSyncV1]: HoloDeviceSyncV1[K] extends (
    ...args: infer A
  ) => infer R ? (...args: A) => Promise<R>
    : never
}

interface HoloDevicePromisesV1 extends PromisifyDeviceSyncV1 {
  getWifiIdentity(): Promise<DeviceReadingV1<WifiIdentityV1>>
  subscribe(options: DeviceSubscriptionOptionsV1): Promise<DeviceSubscriptionV1>
}
```

扫描、用户选择、原始传感器流和位置不属于 v1。SSID/BSSID 只由异步 `getWifiIdentity()` 提供，不进入 summary。

## D.2 Reading 与基础类型

```ts
type HoloAvailabilityV1 =
  | 'available'
  | 'unsupported'
  | 'unavailable'
  | 'permissionDenied'
  | 'redacted'

type DeviceReadingV1<T> =
  | {
    readonly status: 'available'
    readonly value: Readonly<T>
    readonly precision: 'coarse' | 'standard' | 'exact'
    readonly observedAt: number
    readonly revision: number
  }
  | {
    readonly status: 'redacted'
    readonly value: Readonly<T>
    readonly precision: 'redacted'
    readonly observedAt: number
    readonly revision: number
  }
  | {
    readonly status: 'unsupported' | 'unavailable' | 'permissionDenied'
    readonly precision: 'none'
    readonly observedAt: number
    readonly revision: number
  }

type FormFactorV1 =
  | 'phone'
  | 'tablet'
  | 'desktop'
  | 'server'
  | 'tv'
  | 'wearable'
  | 'automotive'
  | 'unknown'
```

`permissionDenied` 表示 Policy 允许该 operation 但 Host/平台拒绝；Policy 本身拒绝时直接抛错，不伪装成 reading。revision 属于 operation key：对应 status/value/precision 的 normalized snapshot 改变时递增，sync/promise/event 读取同一 Provider revision store；`getSummary()` 中每个字段保留其独立 operation revision。

## D.3 标准值

所有 reading value 与 `HoloDeviceSummaryV1` 的精确类型、单位和枚举由[附录 D.2](device-value-types-v1.md)冻结。Summary 不含 Wi-Fi identity、SIM、运营商、基站、MAC、设备标识、安装列表或账户。

## D.4 Operation、隐私与 capability

```ts
type DeviceOperationV1 =
  | 'device.summary.read'
  | 'device.form-factor.read'
  | 'device.connectivity.read'
  | 'device.connectivity.wifi.state.read'
  | 'device.connectivity.wifi.identity.read'
  | 'device.connectivity.cellular.state.read'
  | 'device.power.read'
  | 'device.display.read'
  | 'device.input.read'
  | 'device.thermal.read'
  | 'device.media.capabilities.read'
  | 'device.sensor.capabilities.read'
  | 'device.security.capabilities.read'
  | 'device.lifecycle.read'
  | 'device.events.subscribe'
```

精确映射如下；Network I/O capability 与这些 capability 完全独立：

```ts
const DEVICE_OPERATION_POLICY_V1 = {
  'device.summary.read': [1, 'host.device.summary'],
  'device.form-factor.read': [0, 'host.device.summary'],
  'device.power.read': [1, 'host.device.summary'],
  'device.display.read': [1, 'host.device.summary'],
  'device.input.read': [1, 'host.device.summary'],
  'device.lifecycle.read': [1, 'host.device.summary'],
  'device.connectivity.read': [2, 'host.device.state'],
  'device.connectivity.wifi.state.read': [2, 'host.device.state'],
  'device.connectivity.cellular.state.read': [2, 'host.device.state'],
  'device.thermal.read': [2, 'host.device.state'],
  'device.media.capabilities.read': [2, 'host.device.state'],
  'device.sensor.capabilities.read': [2, 'host.device.state'],
  'device.security.capabilities.read': [2, 'host.device.state'],
  'device.connectivity.wifi.identity.read': [3, 'host.device.sensitive']
} as const
```

`device.events.subscribe` 的 Tier 是 requested kinds 中的最高值，Capability 是对应 kind capability 的 `allOf`。

`DeviceSandboxV2.operations` 必须存在该 operation，且 `maxPrivacyTier` 不小于表中 Tier；否则在 Provider/Middleware 前拒绝。`device.summary.read` 只返回附录 D.2 的 Tier 0/1 字段，不要求 Tier 2 capability，也不得以 redacted reading 偷带 Tier 2 value。订阅按 requested kinds 编译 capability `allOf`。

## D.5 事件与订阅

事件、subscription options、AsyncIterable resource、overflow 和 resync 的精确类型由[附录 D.1](device-events-v1.md)冻结。事件 `value` 不允许回退为 `unknown`。

## D.6 平台 availability

平台支持不使用“API-dependent”自然语言；每个 Provider 必须发布[附录 D.3](device-provider-contract.md)的 machine descriptor。该附录冻结 Android emulator、Desktop 和 Headless Node 的最低 required operation、permission model、precision 和事件能力，以及 runtime status 转换。

固定反例必须证明：只有 `host.device.summary` 时 summary 不含任何 Tier 2 字段；增加 `host.device.state` 后独立 getter 可见；Tier 3 Wi-Fi identity 在所有情况下都不进入 summary。
