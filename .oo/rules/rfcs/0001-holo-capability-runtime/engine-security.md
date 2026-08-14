# RFC-0001：Engine 安全与受控动态代码

[返回 RFC 总览](../0001-holo-capability-runtime.md)

## 16. 动态代码与绕过控制

### 16.1 支持但受控

以下入口属于受控能力，不是统一“不支持”：

```text
eval
indirect eval
Function
AsyncFunction
GeneratorFunction
AsyncGeneratorFunction
WebAssembly compile/instantiate
dynamic import
Inspector Runtime.evaluate
Inspector Runtime.compileScript / runScript / callFunctionOn
```

SandboxPolicy 只定义最大能力和硬限额。下面是 `SandboxPolicyV2.codeGeneration` 字段片段，不是可单独提交的完整 Policy；字段名和 strict Schema 只以附录 A 为准：

```json
{
  "strings": {
    "access": "controlled",
    "maxSourceBytes": 262144,
    "maxOperations": 100,
    "decisionTimeoutMs": 30000
  },
  "wasm": { "access": "none" },
  "dynamicImport": {
    "access": "controlled",
    "maxSourceBytes": 1048576,
    "maxOperations": 100,
    "decisionTimeoutMs": 30000
  }
}
```

是否弹窗或缓存决定由 Host Middleware 负责，不写成 Policy 的 `prompt` 模式。

### 16.2 三个控制平面

#### Invocation Middleware

用于 `node:*`/`holo:*` 能力调用，支持完整异步 before/after、短路、错误恢复和结果替换。

#### Engine Gate

用于代码生成和 Wasm 准入。V8 必须在编译前得到同步的 allow/deny 结果；宿主可以异步执行 Middleware，但 Guest Runtime thread 会在独立通信路径上等待最终决定。

Engine Gate 示例 operation：

```text
runtime.code.generate.strings
runtime.code.generate.wasm
runtime.module.import
```

Node/V8 string callback不能可靠区分 direct/indirect eval 与各 Function constructor；这些只作为可选 detail，不得成为 allow 的安全依据。Wasm 使用独立 Engine callback。精确支持掩码见附录 F。

Gate 的 request、decision、Middleware、一次性 source reader、等待状态机和完整入口矩阵由[附录 F](engine-gate-and-realms.md)冻结。v1 Host 只能返回 `allow` 或 `deny`；不能替换源码，也不能把“允许一次/长期允许”等产品 Grant 写进 Kernel 决策。

#### Runtime Observer

用于旁路监控：

```text
script.compiled
script.execution-started
script.execution-finished
promise.rejected
runtime.exception
runtime.terminated
memory.pressure
gc.completed
```

Observer 必须有界、可丢弃、不可改变执行结果。它可以实现异步监控，但不是授权 Middleware。

每种 Observer event 必须声明 `supportLevel: required | optional | unsupported`、`cost: low | high` 和是否 `optIn`。`execution-started/finished` 只在 Engine 有可靠 hook 时发布；不能用推断事件冒充跨平台统一合同。

### 16.3 Direct eval 语义

必须保留：

```ts
function calculate() {
  const price = 100
  // eslint-disable-next-line no-eval -- RFC demonstrates standard direct-eval lexical semantics.
  return eval('price * 0.8')
}
```

结果仍应为 `80`。不得通过覆盖全局 `eval` 把 direct eval 变成在另一个函数或 Realm 执行。

Node 公共 `vm.createContext()` 只能按 Context 设置字符串/Wasm code generation 的整体 allow/deny。逐次准入需要底层 V8 callback 或等价 Engine 能力。

### 16.4 Node/Desktop 窄 Native Hook

优先方案不是 fork Node，而是：

```text
Node child process
  + Holonomy VM Context
  + Controlled Module Loader
  + Narrow context-aware native addon
  + V8 code-generation callback
```

Native addon 只负责：

- 安装/卸载 Engine callback；
- 将 Engine Context 关联到 processId/generation；
- 生成有界源码元数据和摘要；
- 通过独立线程/IPC 请求 Host 决定；
- 在 timeout、disconnect、restart 时 fail closed 并唤醒 Guest thread；
- 返回 allow/deny 给 V8。

它不负责 UI、Grant Store、业务 Context、文件/网络 Provider 或 Koa executor。

Native Hook 直接使用 V8 API，因此需要按实际支持的 Node/Electron/V8 ABI 构建和验证。加载失败必须显式降级为 generation 级策略或拒绝启动，不能静默变成无限制执行。

### 16.5 动态 import

所有 `import()` 必须回到 Holonomy Module Loader，禁止使用 Main Context 默认 Loader。动态代码产生的 import 继承相同 subject-independent authority、Host Context、generation 和 policyDigest。Loader canonicalization 与 Engine Gate 共享一个 requestId：Loader 先解析并验证 graph/root，Gate 再决定代码生成准入；同一 import 不得重复弹出两个业务授权请求。

### 16.6 Inspector

Inspector 是特权执行面。创建 Inspector lease、`Runtime.evaluate`、`Runtime.compileScript`、`Runtime.runScript`、`Runtime.callFunctionOn` 和 `Debugger.setScriptSource` 需要独立 Service authority，并按附录 F 映射到 Gate。即使通过 Inspector 执行代码：

- `node:*`/`holo:*` 仍解析到受控 Synthetic Module；
- Provider 仍二次授权；
- 不能取得 Host Middleware Registry、Native addon 或 token；
- stale generation lease 必须失败。

### 16.7 不拦截每个普通函数

不得在权限主路径中拦截所有普通函数调用。全函数 tracing 使用可选 Inspector/Profiler 或代码插桩；否则会改变同步语义并产生不可接受的性能成本。

### 16.8 新 Execution Realm

Guest 默认不能取得 ambient `node:vm`、`node:worker_threads`、Web Worker/Worklet、`module._compile`、系统 `createRequire`、`process.binding` 或 `dlopen`。未来开放子 Realm/Worker 时必须由 Host Runtime Factory 创建，继承或收紧 Policy、Context 投影和限额，分配新的 principal，并使用同样的快照、Broker、Provider 和父子取消合同；未知 Realm creator 一律 fail closed。具体矩阵见附录 F。

## 17. 错误模型

Runtime admission、Internal Capability、Node Guest与Holo Guest四个closed error domain只由[附录 E.1](error-contract-v1.md)定义。本节不维护第二份code清单。

接入方可以在Host内使用自己的错误，但普通 `node:*`/`holo:*` facade只接受E.1固定映射。其他Host异常统一变成`middleware.failed`；Host stack、路径、窗口状态、平台异常和Context不得泄露。Policy/capability deny、generation stale与cancel不能被普通Host Middleware恢复成成功。
