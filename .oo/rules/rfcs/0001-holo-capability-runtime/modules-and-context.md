# RFC-0001：模块命名与 Runtime Context

[返回 RFC 总览](../0001-holo-capability-runtime.md)

## 7. 模块命名

### 7.1 命名规则

Node 已有标准模块时必须使用 `node:*`：

```text
node:fs
node:fs/promises
node:os
node:path
node:process
node:http
node:child_process
```

Node 没有对应标准时才使用 `holo:*`：

```text
holo:device
holo:device/promises
holo:runtime
```

不得为已有 Node 标准重复创建 `holo:fs`、`holo:path` 或 `holo:os`。

### 7.2 内部资产

Runtime 内部源码和资产使用：

```text
holo:///runtime/*
```

Runtime Plugin 使用独立的分层 URL scheme：

```text
holo-plugins:///*
```

`holo:<name>` 是公开 Synthetic Module specifier；`holo:///runtime/*` 是 Runtime 自带内部资产；`holo-plugins:///*` 是 Host 提供、Runtime 验证和加载的插件资源。插件不得放入 `holo:///plugins/*`，避免把可装卸资源混入不可变 Runtime 资产身份。完整资源包与加载合同由[附录 K](runtime-plugins-and-watch.md)冻结。

现有 `holonomy:///runtime/*` 需要通过一次原子迁移改为 `holo:///runtime/*`。迁移必须同步更新：

- Module Loader 保留协议；
- Node 和 Android runtime asset manifest；
- Acorn/runtime vendor URL；
- Inspector Sources 标识；
- 测试向量、文档和错误用例。

迁移完成前不得同时长期支持两个内部 scheme，避免形成权限别名。

### 7.3 Host API 不是 Guest 模块

Middleware 注册、Provider 安装和 Runtime 创建属于 Host SDK。Guest 不得导入 `holo:host/*`。该 namespace 保留并默认拒绝，避免 Guest 给自己注册授权逻辑。

## 8. Host 创建 Runtime 与 Context

### 8.1 创建时注入

Runtime Context 必须由可信宿主在创建 Runtime 时提供，不能由 Guest 在入口代码中声明，也不能在 Runtime 启动后静默替换。

Kotlin示意（具体closed fields见附录I）：

```kotlin
val spec = RuntimeCreationSpecV1(
    configuration = runtimeConfiguration,
    hostBindings = admittedHostBindings,
)
val runtime = runtimeEngineFactory.create(spec)
```

Desktop/Service 应在创建 Node 子进程和 VM Context 之前完成同一份 envelope 的验证与冻结。

### 8.2 数据由宿主定义

Holonomy 不定义 Context 的业务字段。三个投影均为有界 JSON：

```ts
type RuntimeContextJson =
  | null
  | boolean
  | number
  | string
  | readonly RuntimeContextJson[]
  | { readonly [key: string]: RuntimeContextJson }

interface RuntimeContextEnvelopeV1 {
  readonly schemaVersion: 1
  readonly host?: RuntimeContextJson
  readonly guest?: RuntimeContextJson
  readonly inspector?: RuntimeContextJson
}
```

宿主可以直接提供三个投影，也可以在 Host SDK 中注册 projector。Projector 是宿主函数，不进入 Guest，不通过公共 OpenAPI 序列化。

### 8.3 投影边界

| 投影        | 可见方                              | 约束                               |
| ----------- | ----------------------------------- | ---------------------------------- |
| `host`      | Host Middleware、可信 Provider 编排 | 不进入 Guest、CDP、日志或公开错误  |
| `guest`     | `holo:runtime`                      | 在 Guest Realm 重建并深冻结        |
| `inspector` | Service discovery、DevTools         | 独立脱敏和限额，不自动继承其他投影 |

`processId`、generation、principal、policyDigest、Provider token 和资源引用由 Holonomy 单独维护，宿主 Context 不得覆盖。

### 8.4 Guest 读取

```ts
import { getContext } from 'holo:runtime'

const context = getContext<MyApplicationContext>()
```

泛型仅提供宿主项目的类型体验，不表示 Holonomy 拥有该业务 Schema。

### 8.5 CDP discovery

标准 CDP 字段继续使用 `id`、`type`、`title` 和 `url`。宿主的 Inspector 投影放在 Holonomy 扩展字段中：

```json
{
  "id": "process-123:4",
  "type": "node",
  "title": "Host supplied title",
  "url": "app+local://workspace/main.mjs",
  "holo": {
    "processId": "process-123",
    "generation": 4,
    "context": {}
  }
}
```

Host 可以不提供 Inspector Context。Service 必须对该投影执行独立的总字节、深度、键数、字符串长度和敏感字段策略。

### 8.6 原子启动

`create` 只建立未执行 Guest 代码的 generation。启动状态固定为：

```text
creating → configuring → admitted → starting → running
```

只有 Context、SandboxPolicy、初始 Middleware、Provider bindings、Engine Gate 和 Inspector 设置全部验证并冻结后，Host 才能调用 `start()`。任一初始绑定失败都会终止该 generation，Guest entry 的副作用必须为零。运行中的 `use()`/`dispose()` 只改变后续调用使用的链快照；restart 以新 generation 原子采用新快照。Service 和 Android command 必须把初始配置与 launch 放在同一事务中，不能依靠 entry 执行后的 control 命令补装。

## 9. Schema Module Registry

每个 `node:*` 或 `holo:*` 模块必须由同一个 Registry 描述：

```ts
interface HoloModuleOperationV1<Args = unknown, Result = unknown> {
  readonly module: string
  readonly member: string
  readonly operation: string
  readonly kind: 'read' | 'invoke' | 'subscribe' | 'open' | 'close' | 'write'
  readonly interception: 'host' | 'systemOnly'
  readonly delivery: FacadeDeliveryV1
  readonly requiredCapabilities: OperationCapabilityRequirementTemplateV1
  readonly snapshotArgs: (value: unknown) => InvocationArgumentSnapshotV1<Args>
  readonly snapshotResult: (
    value: unknown
  ) => InvocationResultSnapshotV1<Result>
  readonly resource: ResourceCanonicalizerV1<Args>
  readonly limits: Readonly<Record<string, number>>
}
```

`InvocationModeV1`、callback tuple、Disposable、二进制与完整 `RuntimeCreationSpecV1` 由[附录 I](core-contract-types.md)唯一拥有。静态 `OperationCapabilityRequirementTemplateV1` 只冻结 capability name/version 的受限 DNF，不携带空对象或通配 constraints；Broker 在参数快照和 CanonicalResource 完成后，按 operation-owned materializer 将 template 编译成[附录 A](policy-and-capabilities.md)的具体 `CapabilityRequirementV1`。具体 requirement 的每个 ref 都必须携带 definition-valid、resource-bounded constraints，之后才能选择 Policy branch。Registry 不接收任意 predicate、脚本或 Guest 提供的 authority。

`host` operation 运行系统层和 Host Koa Middleware；`systemOnly` 仍运行快照、资源、Policy、quota、Provider和结果验证，但 Host Registry 对匹配该 operation 的注册直接拒绝。Network response metadata/body、Bridge resource close/credit 等内部 continuation 是 systemOnly；Registry 生成的 machine docs必须列出 interception，代码不得硬编码 operation 字符串。

稳定 operation 不得直接等同于函数名。不同 Node API 可以映射到同一安全操作：

| 模块与成员                          | Invocation mode | Operation                             |
| ----------------------------------- | --------------- | ------------------------------------- |
| `node:fs.readFileSync`              | `sync`          | `filesystem.file.read`                |
| `node:fs.readFile`                  | `callback`      | `filesystem.file.read`                |
| `node:fs/promises.readFile`         | `promise`       | `filesystem.file.read`                |
| `node:os.networkInterfaces`         | `sync`          | `system.os.network-interfaces.read`   |
| `holo:device.getWifiState`          | `sync`          | `device.connectivity.wifi.state.read` |
| `holo:device/promises.getWifiState` | `promise`       | `device.connectivity.wifi.state.read` |

权限不能通过切换同步、callback 或 Promise 入口绕过。

`node:os`/`node:process`、`node:fs`、Network和`node:child_process`逐成员Registry分别由[附录 C.2](system-operation-registry.md)、[附录 H.1](filesystem-operation-registry.md)、[附录 E.3](network-operation-registry.md)和[附录 J](process-and-linux-backend.md)冻结。说明性章节不得维护第二份operation/callback列表。
