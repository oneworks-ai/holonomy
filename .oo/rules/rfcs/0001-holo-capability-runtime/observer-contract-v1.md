# RFC-0001 附录 F.1：Runtime Observer v1

[返回 Engine Gate](engine-gate-and-realms.md)

Observer 是 Host-only、旁路、可丢弃的监控；它不能授权、阻止、改写或恢复 Runtime 调用。

## F.1.1 注册

```ts
interface RuntimeObserverRegistrationV1 {
  readonly events: readonly RuntimeObserverSelectableEventNameV1[]
  readonly acceptHighCost?: boolean
  readonly maxQueuedEvents?: number
  readonly callbackTimeoutMs?: number
}
type RuntimeObserverV1 = (event: RuntimeObserverEventV1) => void | Promise<void>
interface RuntimeObserverRegistryV1 {
  subscribe(
    registration: RuntimeObserverRegistrationV1,
    observer: RuntimeObserverV1
  ): DisposableV1
}
```

只有 Host 可注册。RuntimeCreationSpec 可携带 initial observer set，与 Policy/Context/Middleware 同一事务冻结；live subscribe/dispose 只影响后续事件。远程 Service 只能引用预注册 owner-bound observer ID，不上传函数。callback 在独立有界 executor 运行，不能进入 Guest Realm。

subscribe admission 逐 event 计算 `DiagnosticsSandboxV2.observerEvents ∩ platform descriptor(supportLevel!=unsupported) ∩ Host hard cap`。任一 event 不在交集、重复或unknown都使整个 registration稳定拒绝，不能静默删项。只要请求集合含descriptor `cost=high`或`optIn=true`事件，`acceptHighCost`必须精确为true；否则稳定拒绝。subscriber `maxQueuedEvents/callbackTimeoutMs` 只能收紧 Policy和Host上限，callback timeout取registration、`DiagnosticsSandboxV2.maxObserverCallbackMs`和Host cap的最小值。`observer.overflow` 是系统事件，不可请求，也不占 Policy selectable set。

`callbackTimeoutMs`省略时使用Policy与Host cap的最小值；显式值必须是1–120000有限整数，0、负数、fraction和超限稳定拒绝，不存在“关闭timeout”。Policy字段也必须显式为1–120000；v1迁移/default-deny canonical值是1，避免never-resolve observer无限占用执行槽。timeout只取消/隔离callback delivery，late settle按registration/generation fencing忽略。

## F.1.2 Event envelope

```ts
interface RuntimeObserverBaseV1<K, P> {
  readonly schemaVersion: 1
  readonly event: K
  readonly sequence: number
  readonly observedAt: number
  readonly generation: number
  readonly correlationId?: string
  readonly payload: Readonly<P>
}
type RuntimeObserverEventV1 =
  | RuntimeObserverBaseV1<'script.compiled', ScriptCompiledPayloadV1>
  | RuntimeObserverBaseV1<'script.execution-started', ScriptStartedPayloadV1>
  | RuntimeObserverBaseV1<'script.execution-finished', ScriptFinishedPayloadV1>
  | RuntimeObserverBaseV1<'promise.rejected', StableErrorPayloadV1>
  | RuntimeObserverBaseV1<'runtime.exception', StableErrorPayloadV1>
  | RuntimeObserverBaseV1<'runtime.terminated', RuntimeTerminatedPayloadV1>
  | RuntimeObserverBaseV1<'memory.pressure', MemoryPressurePayloadV1>
  | RuntimeObserverBaseV1<'gc.completed', GcPayloadV1>
  | RuntimeObserverBaseV1<'observer.overflow', ObserverOverflowPayloadV1>
```

```ts
interface ScriptCompiledPayloadV1 {
  readonly scriptId: string
  readonly sourceSha256: string
  readonly sourceBytes: number
  readonly origin?: string
}
interface ScriptStartedPayloadV1 {
  readonly scriptId: string
  readonly executionId: string
}
interface ScriptFinishedPayloadV1 {
  readonly scriptId: string
  readonly executionId: string
  readonly outcome: 'completed' | 'threw' | 'terminated'
}
interface StableErrorPayloadV1 {
  readonly code: string
  readonly scriptId?: string
}
interface RuntimeTerminatedPayloadV1 {
  readonly reason: 'completed' | 'stopped' | 'failed' | 'lost'
}
interface MemoryPressurePayloadV1 {
  readonly level: 'moderate' | 'critical'
}
interface GcPayloadV1 {
  readonly durationMs: number
  readonly reclaimedBytes?: number
}
interface ObserverOverflowPayloadV1 {
  readonly dropped: number
  readonly droppedByEvent: Readonly<
    Partial<Record<RuntimeObserverSelectableEventNameV1, number>>
  >
  readonly firstDroppedSequence: number
  readonly lastDroppedSequence: number
}
```

sequence 在 generation 内严格递增；observedAt 是 Runtime monotonic ms。scriptId/executionId/correlationId 是 system-minted bounded opaque ID，不是 callToken/provider token。payload 不含源码、callsite、body、Host Context、native error/path/IP；读取源码只能用 EngineSourceReader。

## F.1.3 Delivery 与隔离

- 每 Runtime/registration 有独立 queue，hard cap 取 DiagnosticsSandbox、platform与Host最小值；subscriber只能收紧。queue额外预留一个不可由普通event占用的overflow槽，不突破总Host内存cap。
- 所有 delivery 都不得背压 Runtime。queue满时按确定顺序丢弃：先最旧optional，再最旧required non-terminal；若仍无槽，新event被丢。`supportLevel=required`只保证平台产生语义，不保证慢subscriber不丢。
- 每批丢弃合并一个 `observer.overflow`，记录每类dropped count和首尾sequence；若overflow槽已有事件就原地合并。`runtime.terminated`没有永久保留槽：queue满时可替换最旧non-terminal；若队列只剩正在执行callback，terminal也可丢并计入overflow。Runtime永不等待。
- callback throw、Promise reject、never-resolve/timeout 都被消费并计入 Host diagnostics；不会影响 Runtime或后续 observer。
- callback 不允许同步重入 Guest；Host 发起的新 control 操作进入普通队列，不在 observer stack执行。
- dispose/stop/restart 使未开始 callback失效；已开始 callback的 late settle 被 fencing。Registry close不等待不响应取消的 callback。

`execution-started/finished` 只有 descriptor supportLevel=required 的平台才保证producer为同 executionId至多生成一对；delivery仍可因上述overflow丢失，subscriber必须以overflow失效本地关联状态。Runtime突然丢失时producer可生成 outcome=terminated。optional平台可缺任一事件，业务安全逻辑不得依赖。before/after仍是观察，不是 Middleware。

## F.1.4 固定 tests

覆盖 Policy denied、unsupported、`acceptHighCost`省略/false/true、Policy/registration timeout min/max±1、缺省canonical=1、Policy与Host收紧、timeout late-settle fencing、callback throw/reject/never-resolve、optional/required/terminal queue full、overflow合并/drop计数、reentrant observer、sequence/correlation、producer pairing与delivery gap、termination、dispose/restart late event、多个subscriber隔离，以及源码/body/Context/token/native path不泄漏。
