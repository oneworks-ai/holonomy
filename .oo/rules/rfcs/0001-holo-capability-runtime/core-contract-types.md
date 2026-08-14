# RFC-0001 附录 I：公共基础合同类型

[返回 RFC 总览](../0001-holo-capability-runtime.md)

本附录是所有 Registry 与 Host SDK 的基础类型 owner。规范性章节不得重新定义同名类型。

```ts
type JsonScalarV1 = null | boolean | number | string
type JsonValueV1 =
  | JsonScalarV1
  | readonly JsonValueV1[]
  | { readonly [key: string]: JsonValueV1 }
type JsonScalarOrArrayV1 = JsonScalarV1 | readonly JsonScalarV1[]
```

## I.1 调用与 callback

```ts
type InvocationModeV1 = 'sync' | 'callback' | 'promise'

type OperationCapabilityRefV1 = Readonly<
  { name: BuiltInCapabilityNameV1; version: 1 }
>

interface OperationCapabilityRequirementTemplateV1 {
  readonly anyOf: readonly Readonly<{
    branchId: string
    allOf: readonly OperationCapabilityRefV1[]
  }>[]
}

type OperationCapabilityRequirementV1 =
  | OperationCapabilityRequirementTemplateV1
  | Readonly<{ kind: 'dynamic'; schemaId: string }>
  | Readonly<{ kind: 'inherited' }>
  | Readonly<{ kind: 'unavailable' }>

type OperationResultVariantV1 = Readonly<
  { resultSchemaId: string; whenArgumentsSchemaId: string }
>

type OperationDescriptorV1 = Readonly<{
  module: string
  member: string
  modes: readonly InvocationModeV1[]
  operation: string
  kind: 'close' | 'invoke' | 'open' | 'read' | 'subscribe' | 'write'
  interception: 'host' | 'systemOnly'
  capability: OperationCapabilityRequirementV1
  argsSchemaId: string
  resultSchemaId: string
  resultVariants?: readonly OperationResultVariantV1[]
  deliverySchemaId: string
  resourceSchemaId: string
  limitsOwner: string
}>

type CallbackSuccessDeliveryV1 =
  | { readonly kind: 'void' }
  | { readonly kind: 'result'; readonly resultSchemaId: string }
  | { readonly kind: 'tuple'; readonly tupleSchemaId: string }
  | Readonly<{
    kind: 'variants'
    variants: readonly Readonly<{
      whenArgumentsSchemaId: string
      delivery: Exclude<CallbackSuccessDeliveryV1, { kind: 'variants' }>
    }>[]
  }>

interface CallbackDeliveryV1 {
  readonly errorFirst: true
  readonly success: CallbackSuccessDeliveryV1
  readonly failure: CallbackFailureDeliveryV1
}

type CallbackFailureDeliveryV1 =
  | { readonly kind: 'errorOnly' }
  | { readonly kind: 'errorAndTuple'; readonly tupleSchemaId: string }

type FacadeDeliveryV1 =
  | Readonly<{
    kind: 'invocation'
    invocationModes: readonly InvocationModeV1[]
    callback?: CallbackDeliveryV1
    immediateResultSchemaId?: string
    resourceEvents?: Readonly<{
      eventSchemaId: string
      terminalEvent: string
    }>
  }>
  | Readonly<{
    kind: 'resourceEvents'
    eventSchemaId: string
    terminalEvent: string
  }>
```

`void` 成功精确调用 `callback(null)`；`result` 调用 `callback(null, result)`；`tuple` 调用 `callback(null, ...validatedTuple)`。`variants`只按准入时已冻结的argument Schema选择第一个exact branch，不能在Provider结果后猜测。`errorOnly`失败精确调用`callback(error)`；`errorAndTuple`调用`callback(error, ...validatedTuple)`，只允许Node Registry明确拥有该失败形态的member。不得以 `(null, undefined)` 伪装 `void`，也不得为所有 API 固定两个实参。callback 异步、exactly-once 回到 Guest Event Loop。

`FacadeDeliveryV1.kind='invocation'`必须有非空、去重的mode；只有包含`callback`时才能携带callback。`immediateResultSchemaId`明确表示同一次调用在异步terminal前同步返回resource/boolean等结果；它不创建第二次Broker调用。返回长生命周期resource的invocation可以同时用嵌套`resourceEvents`绑定该resource的Host→Guest event schema与terminal；这不改变调用mode。顶层`resourceEvents`只描述已有resource的独立system event pump，不是callback mode。variants必须非空、互斥、穷尽该overload的argument unions且不能嵌套。machine vectors覆盖void、单result、多result、argument-selected variant、error-only、error+tuple、immediate+callback和resource events的`arguments.length`与顺序。

`OperationDescriptorV1.resultVariants` 是 argument-selected result 的唯一 machine owner。每个
`whenArgumentsSchemaId` 必须是 `argsSchemaId` union 中互斥且穷尽的 branch，每个 `resultSchemaId` 必须是
row 的 aggregate result subset；Kernel 在 Provider 调用前选择并冻结唯一 branch，结果与 callback 都按同一
branch 校验。省略该字段表示结果不依赖参数；实现不得在 Provider 返回后依据值形状猜 branch。

## I.2 Disposable

```ts
interface DisposableV1 {
  dispose(): void
}
interface AsyncDisposableV1 {
  dispose(): Promise<void>
}
```

Registry registration 返回 `DisposableV1`：`dispose()` 同步、幂等、不得抛错，只阻止新调用采用该 registration。长生命周期 Provider resource 返回 `AsyncDisposableV1`；第一次调用拥有清理 terminal，重复调用等待或复用同一 terminal。清理失败只产生稳定 Host diagnostics，不能复活 resource；Runtime stop 不等待不响应取消的 Host callback。

## I.3 Guest 二进制

```ts
interface RuntimeBufferV1 extends Uint8Array {
  toString(encoding?: 'utf8' | 'utf-8' | 'base64' | 'hex'): string
  subarray(start?: number, end?: number): RuntimeBufferV1
}
```

`RuntimeBufferV1` 是 Guest Realm 中由 Holonomy `node:buffer` facade 创建的 Node-compatible v1 子集。每次 Host→Guest 交付复制独立 backing store；Guest 可以修改自己的 bytes，但不能观察 Host/其他 Guest copy。它不是 Host `Buffer`、native pointer 或跨 Realm object。未列 Buffer API 由现有 Node compatibility matrix 决定，不由本 RFC 暗示完整支持。

## I.4 Runtime 创建事务

```ts
interface RuntimeCreationConfigurationV1 {
  readonly schemaVersion: 1
  readonly launch: RuntimeModuleLaunchV1
  readonly context: RuntimeContextEnvelopeV1
  readonly sandboxPolicy: SandboxPolicyV2
  readonly systemProjection: HostSystemProjectionV1
  readonly deviceProviderDescriptor?: DeviceProviderDescriptorV1
  readonly inspector: Readonly<{ enabled: boolean }>
}

interface RuntimeCreationHostBindingsV1<THostContext = unknown> {
  readonly moduleResolver: HostBindingReferenceV1
  readonly initialMiddlewareSet: InitialMiddlewareSetV1<THostContext>
  readonly providerBindings: readonly ProviderBindingRegistrationV1[]
  readonly engineGate: EngineGateRegistrationV1
  readonly initialObservers: readonly RuntimeObserverBindingV1[]
}

interface RuntimeCreationSpecV1<THostContext = unknown> {
  readonly configuration: RuntimeCreationConfigurationV1
  readonly hostBindings: RuntimeCreationHostBindingsV1<THostContext>
}

interface ProviderBindingRegistrationV1 {
  readonly module: string
  readonly providerId: string
  readonly providerVersion: string
  readonly ownerId: string
}

interface RuntimeModuleLaunchV1 {
  readonly entryUrl: string
  readonly moduleRootUrl: string
  readonly moduleGraphDigest: string
  readonly moduleCount: number
  readonly totalSourceBytes: number
}

interface HostBindingReferenceV1 {
  readonly bindingId: string
  readonly ownerId: string
  readonly version: string
}

interface EngineGateRegistrationV1 {
  readonly gateId: string
  readonly ownerId: string
}

interface RuntimeObserverBindingV1 {
  readonly registrationId: string
  readonly ownerId: string
}
```

`configuration` 是 strict、finite JSON：unknown field/accessor/exotic/超限稳定拒绝，可由 Service 持久化并纳入 launch digest。`hostBindings` 是 Host-only SDK object，不进入 JSON/OpenAPI/CDP/Guest；远程调用只提交 owner-bound ID，Service 在 transaction 内解析成实际函数/Provider。

Factory 先快照 configuration，再原子解析全部 Host bindings、编译 Policy/Capability/Registry，最后才产生可 `start()` 的 admitted generation。任一 ID 失效、Schema错误或 binding owner不匹配都会令创建失败，entry side effects=0。RuntimeCreationSpecV1 不接受 Guest principal、generation、authority/token 或任意 Provider function。

## I.5 无悬空类型门禁

M2 machine contract 必须从单一类型图生成 JSON Schema/Registry docs，并拒绝 unresolved normative symbol、重复 type owner 和 Appendix 间不一致 literal。Markdown code fence 通过 TypeScript compile，示例 JSON 通过同一 strict parser；只做链接检查不足以退出 M2。

每个 operation 的 args/result/delivery/resource ID 必须解析到唯一 machine schema owner。owner 冻结
schemaId、role（args/result/delivery/resource/event/tuple）、名称与可独立编译的 strict JSON Schema。Compiler
拒绝 role swap 并校验 delivery 的 mode、callback、immediate result 与 event 引用。生成文档由同一 Registry
输出 operation、capability、resource、interception、args/result、delivery 与 limits，不维护第二份手写表。
