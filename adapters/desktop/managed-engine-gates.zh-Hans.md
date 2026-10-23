# 受管 Native Engine Gate

[English](managed-engine-gates.md) · [Engine Gate 语义](engine-gate.zh-Hans.md)

公开 `holonomy run/test --target native` 使用已安装 Rust/V8 `holo` 及其现有 Host 插件 Gate。Service 只传递冻结的 Policy 和插件 Bundle，不决定或序列化 Native 的放行结果。外部 CLI/Service 可以使用 Node，所选 Runtime 不依赖 Node。

## 配置

本例使用独立 Service home：

```sh
export HOLONOMY_HOME="$PWD/private/holo-service"
mkdir -p "$HOLONOMY_HOME"
chmod 700 "$HOLONOMY_HOME"
```

创建 `$HOLONOMY_HOME/native-runtime.json`，再对该文件执行 `chmod 600`：

```json
{ "schemaVersion": 1, "executablePath": "/absolute/path/to/holo" }
```

使用同一兼容开发构建中的 CLI/Service 和 Native 二进制；旧前端可能仍拒绝这些选项。在项目目录创建 `runtime.json`：

```json
{
  "schemaVersion": 1,
  "context": {
    "schemaVersion": 1,
    "guest": {
      "application": { "id": "example.native-gates", "name": "Native Gates" }
    },
    "host": {},
    "inspector": {}
  },
  "initialMiddlewareId": "service.continue.v1",
  "sandboxPolicy": {
    "schemaVersion": 2,
    "codeGeneration": {
      "strings": { "access": "none" },
      "wasm": {
        "access": "controlled",
        "maxSourceBytes": 4096,
        "maxOperations": 8,
        "decisionTimeoutMs": 1000
      },
      "dynamicImport": {
        "access": "controlled",
        "maxSourceBytes": 4096,
        "maxOperations": 8,
        "decisionTimeoutMs": 1000
      }
    }
  }
}
```

创建 `holo.config.json`：

```json
{ "plugins": [{ "id": "gate", "use": "./gate.mjs" }] }
```

创建 `gate.mjs`。本例只批准空 Wasm 模块的精确摘要和指定模块 URL；应用还应固定获批模块的摘要：

```js
export default ctx => {
  ctx.holo.engineGate(request => {
    if (
      request.operation === 'runtime.code.generate.wasm' &&
      request.sourceSha256 ===
        '93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476'
    ) return { action: 'allow' }
    if (
      request.operation === 'runtime.module.import' &&
      request.origin === 'app://workspace/lazy.mjs'
    ) return { action: 'allow' }
    return { action: 'deny', reasonCode: 'example.not_approved' }
  })
}
```

创建 `lazy.mjs`，内容为 `export const answer = 42`，再创建 `gates.test.mjs`：

```js
import assert from 'node:assert/strict'
import { it } from 'node:test'

it('uses the Native Host Gate', async () => {
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
  assert.ok(await WebAssembly.compile(bytes) instanceof WebAssembly.Module)
  assert.equal((await import('./lazy.mjs')).answer, 42)
})
```

在这个项目目录执行：

```sh
holonomy test ./gates.test.mjs --target native --capability-runtime ./runtime.json --config ./holo.config.json --reporter json
```

预期一个 Guest 测试通过。`run` 与 `test` 都可在启动时静态安装插件；`--watch` 仍只限 `run`。测试使用准入后的固定插件图，不在 suite 中途替换。用 `holonomy process list` 找到本例已结束的进程，再执行 `holonomy process remove <id> --expected-generation 1`，只移除该进程；完成后用 `holonomy service stop` 停止本例独立的 Service。

## 可选的 Host-only 源码读取

Service owner 可扩展同一份私有 `native-runtime.json`：

```json
{
  "schemaVersion": 1,
  "executablePath": "/absolute/path/to/holo",
  "diagnosticSourceReader": {
    "capabilityName": "host.diagnostics.source.read",
    "maxReadBytes": 65536,
    "maxReads": 8
  }
}
```

`maxReadBytes` 为 1 至 1,048,576 的整数，`maxReads` 为 1 至 1,024 的整数。未知字段、错误能力名、非法限额或不安全的安装文件会阻止启动。这是 owner 控制的安装，独立于 Node Adapter 的回调和能力配置，不能由公开 Runtime 请求提交。它在 Service 启动时读取；修改安装后需要 owner 重启该 Service，不由插件配置 watch 更新。

某次运行需要读取时，在该次 `sandboxPolicy` 中添加完整的 `diagnostics` 对象：

```json
{
  "diagnostics": {
    "sourceReader": "boundedSource",
    "maxSourceReadBytes": 4096,
    "observerEvents": [],
    "maxQueuedEvents": 0,
    "maxObserverCallbackMs": 1,
    "retentionMs": 0
  }
}
```

这是待合并的片段，不是完整 Runtime 配置。Host Gate 插件的 async 处理函数随后可在返回决定前使用 `await request.sourceReader.read({maxBytes: 64})`；不要打印得到的字节。字符串、已校验 Wasm 字节和带源码的计划模块，继续使用同一套[读取生命周期和限额](engine-gate.zh-Hans.md#有界源码读取)；synthetic module 不凭空获得源码。

只有安装不会开启读取：即使 Service 已安装，`metadataOnly` 或 `none` 运行仍不注入 reader。反过来，没有 Native 安装的 `boundedSource` 在 Guest 入口前准入失败，Node 回调不能代替授权。有效字节上限为 `min(Policy, 安装, 64 KiB)`；安装的读取次数在该 Runtime 的各类源码 Gate 请求间共享。重启创建新 Runtime 和预算，不复用旧 reader。

Service 只将选中的能力暂存到当代 owner-private Host 配置。reader 对象和原始源码前缀不会进入公开进程 DTO、Gate 元数据、Observer 或普通日志。可信插件仍能主动发布读到的数据，因此插件代码必须受信任。owner 可另行安装[持久源码读取审计](managed-source-audit.zh-Hans.md)；只安装 reader 不开启审计或 [Native Host 插件 Observer 订阅](observer.zh-Hans.md)。

## 边界

- Policy 的 `none`、字节数/次数上限与期限先于 Host 批准；只有 `controlled` 而没有插件明确批准，仍然拒绝。
- CLI 在 Service 启动前捕获有限源码闭包；计算出的 import 不能装入闭包外目标。Gate 批准不是任意文件读取权限。
- Native Gate 保留权威源码摘要、HDO 导入者身份、缓存命中检查、超时/迟到结果隔离及代际清理；不以 Service 内的 Node 回调替代 Native 插件。
- 有界源码读取需要上述 Native 显式安装；[持久审计](managed-source-audit.zh-Hans.md) 是独立 owner 选择，路径由 Service 私下生成，不是公开事件导出 API。[Native Observer](observer.zh-Hans.md) 由 Host 插件按自己的 Policy 注册，不搬运 Service Node 回调 ID。[Desktop Device](device.zh-Hans.md) 有自己的安装和 Policy，这些选项均不会隐式开启其他能力。
- 开发包解压后以空 PATH 验证真实 Wasm 执行，以及 Wasm/import 的允许与拒绝；这项 smoke 不代表完整 M4、跨平台或正式发布验收。
