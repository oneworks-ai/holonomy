# 受控字符串代码生成

[English](engine-gate.md) · [原生桌面端](README.zh-Hans.md)

原生 `holo` 可通过 Host Cordis 插件授权 `eval` 及 Function/AsyncFunction/GeneratorFunction/AsyncGeneratorFunction 构造器。V8 继续使用原源码和 Context，因此 direct eval 保留局部词法绑定；不是全局开启代码生成。

Service 驱动的 `holonomy run/test --target native` 入口见[受管 Native Engine Gate](managed-engine-gates.zh-Hans.md)，包括可选的 owner-private 源码 reader 安装。它使用同一 Native Gate，不通过 Service 内的 Node 回调批准；单独的诊断安装仍独立处理。

必须同时满足 Policy 上限与明确的 Host 决定。最小 `host.json`：

```json
{
  "schemaVersion": 1,
  "sandboxPolicy": {
    "schemaVersion": 2,
    "codeGeneration": {
      "strings": {
        "access": "controlled",
        "maxSourceBytes": 4096,
        "maxOperations": 16,
        "decisionTimeoutMs": 250
      },
      "wasm": { "access": "none" },
      "dynamicImport": { "access": "none" }
    }
  },
  "plugins": [{
    "id": "source-gate",
    "use": "./gate.mjs",
    "config": {
      "approved": [
        "5ea4202659491c599e6e629625e9ee9baad51ddeb6b8e38e7b500dce13a96d44"
      ]
    }
  }]
}
```

`gate.mjs` 只批准精确的 UTF-8 源码 `40+2`：

```js
export default (ctx, config) => {
  ctx.holo.engineGate(async request => {
    if (
      !request.signal.aborted && config.approved.includes(request.sourceSha256)
    ) return { action: 'allow' }
    return { action: 'deny', reasonCode: 'host.not_approved' }
  })
}
```

在 `index.mjs` 写入 `console.log(eval('40+2'))`，执行 `holo --host-config ./host.json ./index.mjs`，预期输出 `42`。

## 中间件和边界

- `ctx.holo.engineGate((request, next) => decision)` 返回可释放的注册；handler 可返回决定或 Promise。外层审计/检查使用 `await next()`，末端必须明确允许；默认终端是拒绝。外层 allow 不能恢复下游 deny，重复 `next()` 即使被插件捕获也会拒绝。
- request 包含冻结的 Engine Gate 元数据与 AbortSignal。源码字节数/摘要可信；callsite、origin、eval/Function 具体入口不可用，不能猜测。可为含源码的字符串、Wasm 与动态模块请求选择下文的有界 Host-only reader。
- Policy 拒绝、源码大小和次数限制先于插件执行。修改插件不能扩大被冻结的 Policy；仅配置 `access: controlled` 而没有 handler 批准，仍然拒绝。
- Guest 在 native 通道等待，Host 异步工作独立推进。到期拒绝编译并 abort signal，迟到的 allow/rejection 会被处理但不能再放行。若 Host 在额外 100 ms 内仍无法确认取消，watchdog 会终止失效的 Runtime generation。
- 及时给出决定与整条中间件结束是两件事。每个已启动 frame 都保留图引用直到 settle，未 await 的 `next()` 也不例外。忽略 abort、永不 settle 的 handler 会占住容量和旧图 drain，不能假装 Promise 已停止；需要停止/重启 Runtime 恢复这种不合作插件。
- Capability 与 Gate scope 共用同一插件 revision。watch 可让新调用使用新图，同时旧调用按原不可变图排空；每个 scope 最多 32 个 handler，每条链最多 128 个，每 Runtime 最多 32 个占用中的 Gate 调用。
- 源码必须可精确编码为 UTF-8：原始孤立 UTF-16 surrogate 会拒绝，以免摘要碰撞；ASCII `\uXXXX` 转义仍可用。禁止替换源码。

## 有界源码读取

所有者可在 `host.json` 添加 `diagnosticSourceReader: {"capabilityName":"host.diagnostics.source.read","maxReadBytes":65536,"maxReads":8}`，并将 `sandboxPolicy.diagnostics.sourceReader` 设为 `boundedSource`、`maxSourceReadBytes` 设为正数；diagnostics 其他必需字段也需提供。Policy 与能力选择缺一或互不匹配时，Guest 入口执行前拒绝。`metadataOnly` 不提供 reader。

含源码的 Gate 请求可在 Host 插件调用 `request.sourceReader?.read({maxBytes: 64})`，取得独立字节副本。字符串与文件动态模块使用精确 UTF-8 字节；Wasm 使用已校验的原始二进制 BufferSource（包括零字节）。synthetic module 明确标记源码不可用，也没有 reader。字节上限取 Policy、所选能力与原生固定 64 KiB 的最小值，`maxReads` 在整个 Runtime 的三类请求间共享。前缀可以截在 UTF-8 字符中间；完整源码字节数与摘要仍在元数据中，前缀只通过私有 Host 字段传送。

读取仅一次，且只在本次决定期间有效；参数错误、重复读取、超时、取消或关闭均以 `engine_source_reader_unavailable` 拒绝。决定结束或取消时，已返回副本会尽力清零，插件应在返回决定前使用。Rust 保存的原始前缀使用 zeroize，V8 管理的副本不能保证完全擦除。源码不进入 Guest、普通日志或 Gate 元数据。以下可选持久审计与实验性 [Inspector](inspector.zh-Hans.md) 分别安装；进程内 restart 证据仍缺。

### 可选的持久读取审计

在 Host 配置中增加 `"diagnosticAudit": {"path":"./private/audit.jsonl","maxBytes":1048576}`。父目录必须已存在、属于当前用户且没有组/其他用户权限（例如 `0700`）；相对路径基于 Host 配置文件，而非 Guest cwd。日志必须是 owner-private、普通单链接文件，禁止跟随叶节点符号链接，并在本 generation 独占锁定；另一 Runtime 应使用另一文件。`maxBytes` 为 1,024 至 16,777,216 的整数，未知字段拒绝。

返回源码副本前，Rust 追加并同步一条有界 JSONL：`schemaVersion:1`、`event:"source.read.admitted"`、随机 `sessionId`、会话内 `sequence`、`generation:1`、Unix 毫秒时间 `observedAt`，以及仅含 `requestId`、`codeKind`、`sourceSha256`、`sourceBytes`、`readBytes` 的 `request`。不记录源码、前缀、URL、callsite、插件配置或 native 路径。事件表示准许复制，不表示插件一定消费了副本。日志及其别名不能作为 Guest 源码加载；Host 显式 FS 授权也应保持该目录私有。

启动时在独占锁下按单条与总字节上限校验既有 JSONL；非法记录或不完整尾部会阻止启动，且不修改历史。选用审计后，追加/同步失败、文件身份无效或容量耗尽会禁用本 generation 后续读取，不返回新的源码副本；不会截断、自动轮转或悄悄写 stderr。容量耗尽后，由 Host 选择新文件并重启；保留与导出策略由 Host 决定。未配置 `diagnosticAudit` 时不宣称具备持久读取审计。本实现覆盖 strings、Wasm、module 的 Engine source reader，不覆盖 Network body reader，也不是完整产品审计服务。

## 受控 WebAssembly

同一个 Host 插件可以授权 `runtime.code.generate.wasm`。在 `codeGeneration.wasm` 中配置 `access: controlled`、`maxSourceBytes`、`maxOperations` 和 `decisionTimeoutMs`；字符串 Policy 独立生效。插件应核对 operation，并批准二进制字节的精确 `sourceSha256`，而不是源码文本摘要。

支持 `new WebAssembly.Module(bytes)`、`WebAssembly.compile(bytes)`、`WebAssembly.instantiate(bytes, imports)`、`WebAssembly.compileStreaming(response)` 和 `WebAssembly.instantiateStreaming(response, imports)`。异步入口包括失败路径都会返回 Promise。对已经准入的 Module 实例化不产生新编译，也不重复消耗编译次数。

Rust 通过内部槽复制有界 BufferSource，核对字节后单次消费绑定 generation、request 和 deadline 的准入记录。V8 回调中的占位字符串不作为二进制源码。Proxy、shared、resizable、detached buffer 均拒绝，不调用 Guest getter 或 Proxy trap。复制前硬上限为 16 MiB，Policy 可进一步收紧；超时和迟到结果隔离复用字符串 Gate。

异步编译/实例化在 imports 绑定和 Promise 终态之前持有原生存活记录，包括入口没有 await 的调用。最多同时保留 32 项，每项最长 120 秒，并受更早的 Runtime 期限限制。拒绝或抛错会释放记录；其他代码的普通未完成 Promise 检查不会因此关闭。

流式入口只接受本 Runtime 的真实 `Response` 或 `Promise<Response>`，要求成功状态与 `Content-Type: application/wasm`；普通对象、Proxy 和伪造的 `Response.fromNetwork` 均拒绝。它通过共享 Response 按 `min(网络 body 上限, 16 MiB)` 有界收集字节，再调用同一个 Rust staging 和 V8 Wasm callback；每次编译只消耗一次 Wasm Gate 决定。通过 `fetch()` 得到的 Response 仍受所选 Network Policy、Provider 和 Response continuation 授权约束；未启用 Network 时不安装 Response/Fetch。MIME、状态、body 读取及网络取消错误会拒绝 Promise，Runtime 关闭或运行期限到达会终止在途操作。此 API 当前先收齐 body 才编译，不是增量 Wasm 编译；不表示 v86 接入或完整 WebAssembly 兼容。

MIME 检查使用 Response 当前的 Headers，包括通过 Headers API 作出的合法修改。修改该 header 不会授予编译权限，Wasm Gate 仍核对实际 body 的精确摘要。

## 受控动态 import

启用 Host 配置后，`codeGeneration.dynamicImport` 默认拒绝。将其配置为 `controlled`、设置同样的字节数/次数/期限字段，并在 `ctx.holo.engineGate` 中明确批准 `runtime.module.import` 才能开启。每次动态调用（包括缓存命中）都会在目标编译/执行前取得决定；静态依赖属于已校验模块计划，不单独算动态调用；嵌套动态 import 各自准入。

模块元数据的 `codeKind` 为 `module`，`origin` 精确指向规范化的目标 URL，`entryDetail` 为 `{kind: dynamicImport, source: loader}`；callsite 不可用。文件目标提供精确 UTF-8 字节数和摘要，引擎提供的 synthetic module 则明确标记源码不可用，不伪造摘要。继续使用同一冻结 Policy、registry revision lease、超时及迟到结果规则。等待 Gate 是异步的，Guest timer 可继续运行，没有 await 的 import 也持有原生存活记录。

模块计划在私有 Context 中通过共享解析器和受描述符约束的源码存储生成。Guest 修改 `Object`/`Array` 原型不能改变计划序列化或源码身份；父模块身份来自私有 V8 host-defined options，而非 `sourceURL` 文本。Planner 对象、Error 原型和函数不会暴露给 Guest。最多保留 128 个原生在途导入，嵌套执行时暂时移出队列的项也计数；Gate 仍独立限制为 32。无法取得可信父模块来源的导入明确拒绝。

未提供 Host 配置时，普通导入仍像之前一样限制在入口根内；提供 Host 配置后，没有插件明确批准就拒绝。这不会扩大允许的 URL scheme，也不会安装任意 npm/native 模块。

部分 Observer 事件见 [Host 配置](host-configuration.zh-Hans.md)；独立的实验性 [Native Inspector](inspector.zh-Hans.md) 也使用同一 Gate。插件替换不追溯撤销已经编译的函数或 Module；Gate 管的是代码生成/加载，不是之后每次调用。目前证据为 macOS arm64，不代表完整 M4 或跨平台兼容性。
