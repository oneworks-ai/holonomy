# RFC-0001 附录 D.1：`holo:device` v1 事件

[返回 Device Schema](device-schema-v1.md)

```ts
type DeviceEventKindV1 =
  | 'connectivity'
  | 'power'
  | 'display'
  | 'thermal'
  | 'lifecycle'

interface DeviceSubscriptionOptionsV1 {
  readonly kinds: readonly DeviceEventKindV1[]
  readonly maxQueuedEvents?: number
}

interface DeviceEventBaseV1<K extends DeviceEventKindV1, V> {
  readonly schemaVersion: 1
  readonly kind: K
  readonly sequence: number
  readonly observedAt: number
  readonly phase: 'snapshot' | 'change'
  readonly reading: DeviceReadingV1<V>
}

interface DeviceOverflowEventV1 {
  readonly schemaVersion: 1
  readonly kind: 'overflow'
  readonly sequence: number
  readonly observedAt: number
  readonly dropped: number
  readonly requiredRevisions: Readonly<
    Partial<Record<DeviceEventKindV1, number>>
  >
  readonly resyncRequired: true
}

type HoloDeviceEventV1 =
  | DeviceEventBaseV1<'connectivity', ConnectivityV1>
  | DeviceEventBaseV1<'power', PowerV1>
  | DeviceEventBaseV1<'display', DisplayV1>
  | DeviceEventBaseV1<'thermal', ThermalV1>
  | DeviceEventBaseV1<'lifecycle', LifecycleV1>
  | DeviceOverflowEventV1

interface DeviceSubscriptionV1 extends AsyncIterable<HoloDeviceEventV1> {
  readonly generation: number
  readonly startSequence: number
  acknowledgeResync(
    revisions: Readonly<Partial<Record<DeviceEventKindV1, number>>>
  ): Promise<void>
  close(): Promise<void>
}
```

v1 不支持历史 replay，也不接受 `afterSequence`。subscribe admission 原子注册平台 callback并冻结各 requested kind 的 baseline，随后按 kind 排序先发布 `phase: snapshot` 的 baseline events，再发布 sequence 更大的 `phase: change` live events；因此 snapshot/live 间没有窗口。`startSequence` 是第一条 baseline 前的 exclusive cursor，只用于诊断。

resync getter映射固定为：connectivity→`getConnectivity/device.connectivity.read`、power→`getPower/device.power.read`、display→`getDisplay/device.display.read`、thermal→`getThermal/device.thermal.read`、lifecycle→`getLifecycle/device.lifecycle.read`。不得用其他getter或summary代替。

sequence 在generation内从1开始严格递增；category-local revision只取`reading.revision`，event envelope不复制第二份revision。`observedAt`使用Runtime单调时钟毫秒。重复/倒序event被丢弃并计入诊断。

队列溢出发布一个合并 overflow，`requiredRevisions` 精确列出受影响 kind 及必须达到的 revision。订阅暂停这些 kind 并只保留每个 kind 最新 reading；其他 kind 可以继续交付。消费者必须调用对应独立 getter（不是 Tier 1 summary），重新经过该 operation 的 Policy/Middleware，然后以实际 reading revisions 调用 `acknowledgeResync()`。所有 revision 达标后，Provider 丢弃不新的 coalesced reading，再按 revision/sequence 发布剩余 change；状态不会倒退。Policy/Middleware 拒绝不会扩大权限，消费者只能稍后重试或关闭订阅。

`maxQueuedEvents` 只能收紧 Policy hard cap。close、Runtime stop、restart 与 Provider revoke 共享 exactly-once terminal；旧 generation cursor 不可续传。订阅事件只包含对应 discriminated reading，不携带 SSID/BSSID、SIM、原始传感器样本或平台 callback object。

固定测试覆盖 connectivity+thermal 同时溢出、permissionDenied/Host 撤销、resync 中新事件、错误/未来 revision ack、原子 baseline/live、restart cursor 和 Tier 2 不能通过 summary 恢复。
