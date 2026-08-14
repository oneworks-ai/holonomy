# RFC-0001 附录 D.3：Device Provider Contract

[返回 Device Schema](device-schema-v1.md)

```ts
type DeviceProviderOperationDescriptorV1 =
  | Readonly<{
    operation: DeviceOperationV1
    supportLevel: 'required' | 'optional'
    permissionModel: 'none' | 'host' | 'platform' | 'hostAndPlatform'
    maxPrecision: 'redacted' | 'coarse' | 'standard' | 'exact'
    eventKinds: readonly DeviceEventKindV1[]
  }>
  | Readonly<{
    operation: DeviceOperationV1
    supportLevel: 'unsupported'
    permissionModel: 'none'
    maxPrecision: 'none'
    eventKinds: readonly []
  }>
interface DeviceProviderDescriptorV1 {
  readonly schemaVersion: 1
  readonly target: 'android' | 'desktop' | 'node'
  readonly providerVersion: string
  readonly operations: readonly DeviceProviderOperationDescriptorV1[]
}
```

descriptor 必须精确列出所有 DeviceOperationV1，去重排序；缺项/重复/unknown 拒绝。required 表示该 target 的合规 Provider 必须实现；optional 在当前 Host 有实现时可返回 available/unavailable/redacted，否则返回 unsupported；unsupported 永远返回 unsupported且不能触发 ambient fallback。

只有`device.events.subscribe`可声明非空eventKinds，且每个kind必须有对应read operation非unsupported；其他operation的eventKinds精确为空。unsupported branch不能伪造permission/precision/event支持。

## D.3.1 最低 required 集合

| Target                  | Exact required `DeviceOperationV1`                                                                                                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android emulator/device | `device.summary.read`, `device.form-factor.read`, `device.connectivity.read`, `device.connectivity.wifi.state.read`, `device.connectivity.cellular.state.read`, `device.power.read`, `device.display.read`, `device.input.read`, `device.lifecycle.read`, `device.events.subscribe` |
| Desktop                 | `device.summary.read`, `device.form-factor.read`, `device.display.read`, `device.input.read`, `device.lifecycle.read`, `device.events.subscribe`                                                                                                                                    |
| Headless Node           | `device.summary.read`, `device.form-factor.read`, `device.lifecycle.read`                                                                                                                                                                                                           |

Android `device.events.subscribe` required eventKinds精确为connectivity/power/display/lifecycle；Desktop精确为display/lifecycle；Headless该operation unsupported。required表本身作为machine vector输入，不存在说明性alias。

Android thermal/media/sensor/security/Wi-Fi identity是 optional；Desktop connectivity/power/thermal/media/sensor/security/Wi-Fi identity是 optional；Headless 其他 operation是 unsupported。optional 的实际状态由 descriptor machine vector给出，不能在文档里声称通用 available。

permissionModel=none仍受 SandboxPolicy；host 表示需要 Host Middleware；platform 表示可能返回 permissionDenied；hostAndPlatform 两者都需要。runtime 转换固定为：descriptor unsupported→unsupported；实现不存在/暂不可读→unavailable；平台/Host在Policy已允许后拒绝→permissionDenied；主动粗化→redacted；有效值→available。

## D.3.2 值 Schema 不变量

所有值使用 strict JSON Schema `additionalProperties:false` 与以下 if/then：

- Wifi/Cellular connected=false 时不得有 signal；Cellular radio 必须为 unknown。WifiIdentity available 时 ssid/bssid 至少一个存在。
- hasBattery=false 时不得有 level，charging=false，source不得为 battery；level/signal 是整数 0–100。
- Display width/height 是 1–1,000,000 的整数 CSS px，scale 0.25–16，refresh 1–1000 Hz；可选值缺失与 unknown 不混用。
- Input maxTouchPoints 是 0–64 整数；touch=false 必须为0，touch=true必须至少1。
- sensor list 最多32、去重排序；SSID最多256 UTF-8 bytes；BSSID为小写 canonical MAC。
- finite number only；所有 enum/array/string 有 hard cap，wrong type/unknown key拒绝。

Reading 的 discriminant只由附录D的`DeviceReadingV1`拥有：available必须有value且precision=coarse|standard|exact；redacted必须有类型保持value且precision=redacted；其他status不得有value且precision=none。

## D.3.3 Revision 与 vectors

revision scope 是 DeviceOperationV1。Provider 对 normalized `{status,value,precision}` 的变化原子递增非负 safe integer；observedAt变化本身不增 revision。事件 category 映射对应 read operation revision，summary字段沿用各 getter revision。

共享 vectors校验 descriptor最低集合、optional/unsupported转换、每个 if/then 非法组合、范围、reading discriminant、revision increment、sync/promise/event同源，以及 Provider 宣称required却返回unsupported时contract失败。
