# Service Native 源码读取审计

[English](managed-source-audit.md) · [源码 reader](managed-engine-gates.zh-Hans.md#可选的-host-only-源码读取)

Service owner 可要求 Native Engine reader 在返回源码副本前，先同步写入有界元数据记录。它复用独立入口的 Rust 审计 writer，不记录源码文本、不授予读取权限，也不配置 Observer 输出。

## Owner 安装

按[受管 Gate 配置](managed-engine-gates.zh-Hans.md#配置)使用隔离的 `HOLONOMY_HOME`。在 owner-only 的 `native-runtime.json` 同时选择 reader 和 audit：

```json
{
  "schemaVersion": 1,
  "executablePath": "/absolute/owner-selected/holo",
  "diagnosticSourceReader": {
    "capabilityName": "host.diagnostics.source.read",
    "maxReadBytes": 65536,
    "maxReads": 8
  },
  "diagnosticAudit": { "maxBytes": 1048576 }
}
```

安装文件必须是有界、仅 owner 可读的普通文件，leaf 不得为符号链接。`diagnosticAudit` 只接受必需的 `maxBytes`，为 1024 至 16777216 的整数。省略表示不安装；`null`、未知字段和路径均无效。输出位置由 Service 生成。安装在 Service 启动时冻结，修改需 owner 重启，不由插件 watch 更新。

只选 audit 不能安装 reader。每次 Runtime 仍须独立获得既有 `boundedSource` Policy 和 Native reader 选择。`metadataOnly`、`none` 即使有 audit 安装，也不暂存 writer/文件。Node、Android 不消费这份 Native 安装。

## 最小真实读取

在项目内创建 `runtime.json`：

```json
{
  "schemaVersion": 1,
  "context": { "schemaVersion": 1 },
  "initialMiddlewareId": "service.continue.v1",
  "sandboxPolicy": {
    "schemaVersion": 2,
    "codeGeneration": {
      "strings": {
        "access": "controlled",
        "maxSourceBytes": 4096,
        "maxOperations": 8,
        "decisionTimeoutMs": 1000
      },
      "wasm": { "access": "none" },
      "dynamicImport": { "access": "none" }
    },
    "diagnostics": {
      "sourceReader": "boundedSource",
      "maxSourceReadBytes": 4096,
      "observerEvents": [],
      "maxQueuedEvents": 0,
      "maxObserverCallbackMs": 1,
      "retentionMs": 0
    }
  }
}
```

创建 `gate.mjs`：

```js
export default ctx => {
  ctx.holo.engineGate(async request => {
    if (request.operation !== 'runtime.code.generate.strings') {
      return { action: 'deny', reasonCode: 'example.unexpected_operation' }
    }
    const bytes = await request.sourceReader.read({ maxBytes: 4 })
    return bytes.length === 4 && bytes[0] === 52 && bytes[1] === 48 &&
        bytes[2] === 43 && bytes[3] === 50
      ? { action: 'allow' }
      : { action: 'deny', reasonCode: 'example.unexpected_source' }
  })
}
```

创建 `holo.config.json`：

```json
{ "plugins": [{ "id": "gate", "use": "./gate.mjs" }] }
```

创建 `index.mjs`：

```js
// eslint-disable-next-line no-eval -- Explicitly exercise the controlled Native Engine source reader.
console.log(eval('40+2'))
```

```sh
holonomy run ./index.mjs --target native --capability-runtime ./runtime.json --config ./holo.config.json --detach
```

命令返回进程 ID，Guest 输出为 `42`。Host reader 在返回 Gate 决定前消费前缀，不打印源码。`holonomy test` 也可使用同一静态安装；测试不启用插件 watch。

## 私有记录与生命周期

默认 state 布局下，Host owner 可读取：

```text
HOLONOMY_HOME/state/native-processes/<processId>/g<generation>/host/audit/source-reads.jsonl
```

这不是公开 endpoint、DTO 字段或 Guest 路径。私有目录/文件权限为 `0700`/`0600`，Rust 复核打开的描述符、单硬链接身份和独占锁。自定义 state 目录会改变前缀；显式 Host FS grant 也须保证该目录私有。

记录沿用[持久读取审计的 schema 和失败规则](engine-gate.zh-Hans.md#可选的持久读取审计)：只有 `source.read.admitted`、随机 session、sequence、本地 Runtime `generation:1`、时间，以及 request ID/kind/源码摘要/字节数。外层 Service generation 由目录表示，不改写 Rust 记录。每次 append 在返回源码副本前完成同步；它证明获准复制，不证明插件已消费副本。

容量、身份或 append/sync 失败会在返回额外源码副本前，永久停用该代际后续读取。不截断、不轮转、不退回 stderr。它不暗中放行 Gate，可信 handler 仍负责决定。普通插件 watch 不能替换 audit 配置。重启使用新代际文件/session；移除进程会清理自有文件，需要的记录请先保存。

示例仍在运行时先执行 `holonomy process stop <process-id>`，再用 `holonomy process remove <process-id>` 移除已结束资源，最后仅针对本例隔离 home 执行 `holonomy service stop --drain`；不要 drain 共享 Service。

未安装 audit 时，既有 reader 仍可使用，但不保证持久审计。此能力覆盖 Engine 源码读取，不覆盖 Network 正文检查、完整审计服务或任意 inline Observer 回调。Native 执行仍为 Rust/V8 且不依赖 Node；外部 CLI/Service 可使用 Node。当前执行覆盖为 macOS arm64，不代表正式发布或所有平台验收。
