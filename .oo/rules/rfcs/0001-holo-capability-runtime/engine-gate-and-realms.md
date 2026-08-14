# RFC-0001 附录 F：Engine Gate 与 Execution Realm

[返回 RFC 总览](../0001-holo-capability-runtime.md)

Engine Gate 与 Invocation Broker 是两条流水线。Gate 只决定 Engine 是否可以继续编译/实例化，不调用普通 Provider，也不允许 Host 替换源码或结果。

## F.1 Gate 合同

```ts
type EngineGateOperationV1 =
  | 'runtime.code.generate.strings'
  | 'runtime.code.generate.wasm'
  | 'runtime.module.import'

interface EngineGateMetadataSupportV1 {
  readonly source: 'available' | 'unavailable'
  readonly entryDetail: 'exact' | 'unavailable'
  readonly callsite: 'exact' | 'unavailable'
  readonly origin: 'exact' | 'unavailable'
}

interface EngineGateEntryDetailV1 {
  readonly source: 'loader' | 'inspector' | 'trustedWrapper'
  readonly kind:
    | 'dynamicImport'
    | 'inspectorEvaluate'
    | 'inspectorCompile'
    | 'inspectorRunScript'
    | 'inspectorCallFunction'
    | 'debuggerSetScriptSource'
}

interface EngineGateRequestV1 {
  readonly schemaVersion: 1
  readonly requestId: string
  readonly operation: EngineGateOperationV1
  readonly codeKind: 'strings' | 'module' | 'wasm'
  readonly metadataSupport: EngineGateMetadataSupportV1
  readonly sourceBytes?: number
  readonly sourceSha256?: string
  readonly entryDetail?: EngineGateEntryDetailV1
  readonly origin?: string
  readonly callsite?: Readonly<
    { moduleUrl: string; line?: number; column?: number }
  >
  readonly runtime: Readonly<{
    processId: string
    generation: number
    policyDigest: string
  }>
  readonly sourceReader?: EngineSourceReaderV1
  readonly signal: AbortSignal
}

interface EngineSourceReaderV1 {
  read(options: { readonly maxBytes: number }): Promise<Uint8Array>
}

type EngineGateDecisionV1 =
  | { readonly action: 'allow' }
  | { readonly action: 'deny'; readonly reasonCode: string }

type EngineGateMiddlewareV1 = (
  request: EngineGateRequestV1,
  next: () => Promise<EngineGateDecisionV1>
) => Promise<EngineGateDecisionV1>
```

产品的“允许一次/长期允许/按模块允许”由 Host Middleware 自己实现，不进入 `EngineGateDecisionV1`。v1 禁止 source replacement；未来若需要，必须是独立 capability/RFC，不能伪装成 allow。

安全决定只能依赖 operation、Context、Policy 和 `metadataSupport=available/exact` 的字段。缺失 metadata 不得猜测或伪造；需要 source hard limit而 source unavailable 时 fail closed。entryDetail 只能进一步收紧，不能把粗粒度 strings Gate 的拒绝改成 allow。

`sourceReader` 是 Host-only、generation-bound、一次性 token。只有Policy diagnostics.sourceReader=boundedSource、selected `host.diagnostics.source.read` capability和Host hard cap三者同时允许时存在；读取受三者最小bytes/reads、deadline和audit限制。源码永不进入Guest、CDP discovery、普通日志或Observer event；reader close、timeout、restart后稳定失败。

## F.2 等待状态机

```text
captured → policyChecked → waitingHost → allowed | denied | cancelled | timedOut
```

- Node/Desktop capability probe 必须报告实际安装的 string callback 与独立 Wasm callback，以及各 metadata support。string callback 最低只保证 Context、source value和 `is_code_like`；不声称区分 direct/indirect eval、Function kind、origin或callsite。
- source 是可安全读取的 String 时捕获 bytes/digest；否则 metadata 标 unavailable并按 Policy fail closed。同一 request 只能有一个终态。
- Host 决定通过独立 native thread/IPC 执行，不能依赖被阻塞的 Guest Node loop、Android UI 或 Electron renderer。
- deadline、Abort、Host disconnect、Runtime stop/restart 都唤醒等待并 fail closed。
- Middleware `next()` 最多一次；递归 Engine Gate 使用独立 depth cap，超限拒绝。
- allow 后 V8 在原 Context 继续原始编译，因此 direct eval lexical semantics 保持不变。
- deny/timeout/cancel 使用稳定 Engine internal terminal；late Host 决定被 generation/request fencing 丢弃。

## F.3 完整入口矩阵

| 入口                              | Gate operation                | 精确信息来源                                   | v1                     |
| --------------------------------- | ----------------------------- | ---------------------------------------------- | ---------------------- |
| direct/indirect eval              | runtime.code.generate.strings | V8 无法区分，detail unavailable                | controlled coarse Gate |
| Function constructors 四类        | runtime.code.generate.strings | wrapper detail非权威/可无                      | controlled coarse Gate |
| Wasm Module/compile/instantiate   | runtime.code.generate.wasm    | 独立 Wasm callback                             | controlled             |
| Wasm streaming                    | runtime.code.generate.wasm    | Network bytes+Wasm callback                    | controlled             |
| dynamic import                    | runtime.module.import→strings | Loader exact detail+最终coarse Gate            | controlled             |
| CDP evaluate/compile/callFunction | runtime.code.generate.strings | Inspector Policy exact command+最终coarse Gate | controlled             |
| Debugger.setScriptSource          | runtime.code.generate.strings | Inspector Policy                               | default deny           |
| node:vm/worker_threads            | N/A                           | module/global不存在                            | unreachable            |
| Worker/Worklet/ShadowRealm        | N/A                           | global不存在                                   | unreachable            |
| module._compile/createRequire     | N/A                           | native loader不可达                            | unreachable            |
| process.binding/dlopen/addon      | N/A                           | native入口不可达                               | unreachable            |
| data/blob/file import             | N/A                           | Loader scheme/root固定拒绝                     | deny                   |

未知代码生成或 Realm creator fail closed。v1 没有可显式开启 data/blob/file import 或子 Realm 的 Policy 字段；开放它们需要新 schemaVersion/RFC。Inspector lease authority 不能替代 Policy。

## F.4 受控子 Realm/Worker

本节是未来版本接入条件，不是 v2 Policy 可开启能力。开放前必须新增 realmCreation/moduleLoading schema 和 closed operation。子执行面只能由 Host Runtime Factory 创建，并且：

- 继承或收紧父 SandboxPolicy，不得放大；
- 获得新 principal、resource namespace、limits 和取消树；
- 由 Host 明确投影 Context，不复制 Middleware Registry/Provider native object；
- 使用相同 Module Registry、ArgumentSnapshot、Broker 和 Provider reauthorization；
- 对 message 做 descriptor-safe、quota-bounded Realm copy；
- 父 stop/restart/disconnect 时先取消子执行面，再完成父终态。

## F.5 Observer 合同

```ts
type RuntimeObserverSelectableEventNameV1 =
  | 'script.compiled'
  | 'script.execution-started'
  | 'script.execution-finished'
  | 'promise.rejected'
  | 'runtime.exception'
  | 'runtime.terminated'
  | 'memory.pressure'
  | 'gc.completed'

type RuntimeObserverEventNameV1 =
  | RuntimeObserverSelectableEventNameV1
  | 'observer.overflow'

interface RuntimeObserverDescriptorV1 {
  readonly event: RuntimeObserverSelectableEventNameV1
  readonly supportLevel: 'required' | 'optional' | 'unsupported'
  readonly cost: 'low' | 'high'
  readonly optIn: boolean
}
```

`script.compiled`、exception 和 terminal 可在支持平台 required；execution-started/finished、GC、Promise/Profiler 类事件通常 optional/high/opt-in。Observer 是有界、可丢弃、只读旁路；after event 不能授权、修改结果或延迟 Engine terminal。

Host 注册、事件 envelope、payload、队列、overflow、callback 隔离和 generation fencing 由[附录 F.1](observer-contract-v1.md)冻结。

## F.6 固定 conformance

专项 corpus 除现有 direct/indirect eval、Function、Wasm、dynamic import 外，必须覆盖真实 hook capability probe、缺失 metadata fail-closed、CDP compile/run/callFunction/setScriptSource、Wasm streaming/Module、Loader+Gate requestId 去重、source reader 一次性与泄漏、timeout/disconnect/restart、multiple Context，以及无法取得 vm/worker/module native escape。测试不能声称 V8 hook 能区分其未提供的 entry detail。只在相关 Engine/升级/发布矩阵运行。
