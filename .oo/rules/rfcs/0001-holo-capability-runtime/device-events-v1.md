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
  readonly maxQueuedEvents: number
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

generation-bound Runtime Subscription Resource拥有消费队列；Host Provider只发布经过Schema验证的baseline/live reading，不观察Guest消费速度。队列溢出时Resource用一个合并overflow替换尚未消费的reading，`requiredRevisions`精确列出受影响kind及必须达到的revision，并只保留每个kind最新reading；其他kind仍可继续交付。消费者必须调用对应独立getter（不是Tier 1 summary），重新经过该operation的Policy/Middleware，然后以实际reading revisions调用`acknowledgeResync()`。所有revision达标后，Resource丢弃不新的coalesced reading，再按kind稳定排序分配新的sequence并发布剩余change；状态不会倒退。错误、缺失或未来revision以`holo.invalid_arguments`拒绝。Policy/Middleware拒绝不会扩大权限，消费者只能稍后重试或关闭订阅。

`maxQueuedEvents`省略时取`DeviceSandboxV2.maxQueuedEvents`，显式值只能收紧该hard cap；有效值由Provider写入受校验的`DeviceSubscriptionV1` facade，Resource不得采用环境默认值。close、Runtime stop、restart与Provider revoke共享exactly-once terminal；旧generation cursor不可续传。订阅事件只包含对应discriminated reading，不携带SSID/BSSID、SIM、原始传感器样本或平台callback object。

固定测试覆盖 connectivity+thermal 同时溢出、permissionDenied/Host 撤销、resync 中新事件、错误/未来 revision ack、原子 baseline/live、restart cursor 和 Tier 2 不能通过 summary 恢复。
