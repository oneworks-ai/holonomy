# RFC-0001：Invocation Broker 与中间件

[返回 RFC 总览](../0001-holo-capability-runtime.md)

## 10. Invocation Broker

### 10.1 调用上下文

Holonomy 不枚举业务主体类型。Host Context 作为宿主自定义泛型进入 Middleware：

```ts
interface HoloInvocationContext<THostContext = unknown, Args = unknown> {
  readonly requestId: string
  readonly module?: string
  readonly member?: string
  readonly operation: string
  readonly kind:
    | 'read'
    | 'invoke'
    | 'subscribe'
    | 'open'
    | 'close'
    | 'write'
  readonly invocationMode: InvocationModeV1
  readonly phase: 'requested' | 'resolved'

  readonly hostContext: Readonly<THostContext>
  readonly arguments: InvocationArgumentSnapshotV1<Args>
  readonly hostBindings: readonly HostOnlyInvocationBindingV1[]
  readonly resource?: Readonly<{
    requested: CanonicalResourceV1
    resolved?: CanonicalResourceV1
    binding: InvocationResourceBindingV1
  }>
  readonly callsite?: Readonly<{
    moduleUrl: string
    line?: number
    column?: number
  }>

  readonly runtime: Readonly<{
    processId: string
    generation: number
    target: 'node' | 'desktop' | 'android'
    engine: string
    policyDigest: string
  }>

  readonly capabilities: readonly CapabilityBindingV1[]
  readonly authorityBindings: readonly AuthorityBindingV1[]

  readonly signal: AbortSignal
  readonly state: Map<unknown, unknown>
}
```

除 `state` 外，所有权威字段均为只读快照。`state` 只在当前调用链中共享，不跨请求、不传给 Guest。

`arguments` 不是 Guest 对象；它是系统层按[附录 B](resources-and-snapshots.md)重建的 Host Realm、无 accessor、无 prototype、深冻结快照。`capabilities` 和 `authorityBindings` 由 Policy compiler 生成，Host Middleware 只能读取，不能添加或放宽。

### 10.2 Koa 风格 Middleware

```ts
type HoloMiddleware<THostContext = unknown> = (
  ctx: HoloInvocationContext<THostContext>,
  next: () => Promise<unknown>
) => unknown | Promise<unknown>

interface RuntimeInterceptorRegistry<THostContext = unknown> {
  use(
    matcher: HoloInvocationMatcher,
    middleware: HoloMiddleware<THostContext>
  ): DisposableV1
}

interface InitialMiddlewareSetV1<THostContext = unknown> {
  readonly schemaVersion: 1
  readonly registrations: readonly Readonly<{
    registrationId: string
    layer: 'embedder' | 'application'
    matcher: HoloInvocationMatcher
    middleware: HoloMiddleware<THostContext>
  }>[]
}
```

Host SDK 必须同时提供不可变 `initialMiddlewareSet`，供 Runtime 创建事务在 Guest entry 前安装。运行态 Registry 只面向后续调用；它不能补救缺失的初始安全链。

Middleware 函数只存在于可信 Host SDK，不通过 OpenAPI 上传。远程 Service launch 只能引用 Service 预注册且 owner-bound 的 middleware registration ID；Service 在创建 generation 前解析成同一 snapshot，未知/失效 ID 会令启动失败。

示例：

```ts
const dispose = runtime.interceptors.use(
  {
    module: 'node:fs',
    operation: 'filesystem.file.read'
  },
  async (ctx, next) => {
    const allowed = await hostApplication.authorize(ctx)
    if (!allowed) throw hostApplication.createDeniedError(ctx)

    try {
      const result = await next()
      await hostApplication.auditSuccess(ctx)
      return result
    } catch (error) {
      await hostApplication.auditFailure(ctx, error)
      throw error
    }
  }
)
```

语义必须固定：

- `next()` 最多调用一次；重复调用产生稳定 Middleware 错误；
- 不调用 `next()` 并直接返回会短路后续 Middleware 和 Provider；
- 短路结果仍必须经过结果 Schema、配额、Realm 重建和脱敏；
- 抛错会中止调用；Host 内部异常必须映射为稳定、无敏感信息的 Guest 错误；
- `dispose()` 只影响之后的新调用，不撤销已经进入链路的调用；
- Runtime stop/restart、deadline 或 AbortSignal 必须取消正在等待的 Middleware；
- 不可移除的系统 Middleware 位于宿主 Middleware 外层。

### 10.3 Matcher

Matcher 使用结构化字段和受限 glob，不接受任意正则或可执行表达式：

```ts
interface HoloInvocationMatcher {
  readonly module?: string
  readonly member?: string
  readonly operation?: string
  readonly kind?: HoloInvocationContext['kind']
  readonly invocationMode?: HoloInvocationContext['invocationMode']
  readonly phase?: HoloInvocationContext['phase']
  readonly resource?: CanonicalResourceMatcherV1
}
```

Matcher 只作用于已规范化的资源字段，不对原始 path/URL 做字符串 prefix。注册顺序决定洋葱顺序。系统 Middleware、企业/Embedder Middleware 和应用 Middleware 应使用不同 Registry 层级，后层不能移除前层。

## 11. 职责：Holonomy 与接入应用

### 11.1 Holonomy 负责

- Sandbox 最大权限与硬限额；
- 标准 operation、Context、Middleware executor 和 `next()` 语义；
- 参数/结果 Schema、跨 Realm 重建、取消、deadline 和 generation fencing；
- Provider 调度、二次授权要求和稳定错误边界；
- 有界、脱敏的生命周期事件；
- Engine 能力描述和支持矩阵。

### 11.2 接入应用负责

- 是否弹窗以及弹窗样式和文案；
- 如何理解 Host Context；
- 是否缓存决定、缓存多久、使用什么 key；
- 按文件、目录、模块、租户还是其他业务范围授权；
- Grant 存储、撤销、企业策略、家长控制或审计后台；
- 应用自己的公开错误类型和用户体验。

SandboxPolicy 不包含 `prompt`。它只表达最大能力，例如是否允许字符串代码生成、文件系统根和网络 authority。Middleware 决定是否询问用户。

### 11.3 可选 Permission 与 Audit 插件

Holonomy 提供可信请求/事件 Schema、Cordis 注册点、默认错误、脱敏、sequence/correlation 和可选基础组件；应用提供授权 UI、决定逻辑、持久化与审计目的地。两者都是普通 JavaScript/Cordis Runtime Plugin，不建立 Native 插件变体：

```text
@holonomyjs/plugin-permission
@holonomyjs/plugin-audit
```

它只组合常见流程，并把身份解析、决定、存储、key 和错误全部留给调用方：

```ts
const middleware = createPermissionMiddleware({
  resolveRequest: ctx => application.resolvePermissionRequest(ctx),
  decide: request => application.showPermissionDialog(request),
  readDecision: key => applicationGrantStore.get(key),
  writeDecision: (key, value) => applicationGrantStore.set(key, value),
  createKey: request => application.createGrantKey(request),
  createDeniedError: request => application.createDeniedError(request)
})
```

Audit 插件通过标准 `AuditSinkV1` 消费 Kernel 产生的有界事件；它不参与 allow/deny。示例必须同时展示完全自行编写 Middleware 和使用可选包两种方式。插件不得进入 Runtime Kernel 依赖图，安装、资源身份与动态装卸遵守[附录 K](runtime-plugins-and-watch.md)。
