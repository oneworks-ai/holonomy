# Service Native 诊断 Profile（实验性）

[English](managed-observer-profiles.md) · [独立执行器](observer-profiles.zh-Hans.md)

Service owner 私下安装 Native 诊断模块。公开 Native Runtime 请求只选择逻辑 `initialObserverIds`，不能提交回调函数、模块源码、Host 路径或 sink 路径。同名 Node 函数不构成 Native 安装授权。

## Owner 安装

本例使用独立 Service home：

```sh
export HOLONOMY_HOME="$PWD/private/holo-service"
mkdir -p "$HOLONOMY_HOME/modules"
chmod 700 "$HOLONOMY_HOME" "$HOLONOMY_HOME/modules"
```

用 `HOLONOMY_HOME/native-runtime.json` 安装兼容 Rust `holo`，该文件设为 `0600`：

```json
{ "schemaVersion": 1, "executablePath": "/absolute/owner-selected/holo" }
```

创建 `HOLONOMY_HOME/modules/diagnostic.mjs`：

```js
export default (event, config, sink) => {
  if (event.event === 'script.compiled') sink.publish()
}
```

创建 `HOLONOMY_HOME/native-observer-profiles.json`，并把清单权限设为 `0600`：

```json
{
  "schemaVersion": 1,
  "profiles": {
    "monitor": {
      "use": "./modules/diagnostic.mjs",
      "export": "default",
      "config": {},
      "registration": {
        "acceptHighCost": true,
        "events": ["script.compiled"],
        "maxQueuedEvents": 16,
        "callbackTimeoutMs": 1000
      },
      "sink": { "maxBytes": 1048576 }
    }
  }
}
```

缺少清单表示没有安装。未知字段、不安全的所有权/权限、注册/源码/schema/integrity 无效，或存在清单却未安装 Native 二进制，均会拒绝 Service 启动。读取只接受当前 OS 用户拥有的有界、普通、no-follow 文件，最多 1 MiB。

`use` 相对该清单解析，不相对调用方项目。资源准备复用 Native 私有源 reader 和现有 Host bundle collector，不退回 Node 文件源读取，也不执行模块。可选顶层 `pluginRoots` 显式允许其中的绝对源；自包含 ESM/package/pnpm 子集不变。最多四个 profile，ID 为安全的 1–64 字节标识符。config 最多 64 KiB，源单文件 1 MiB、总量 4 MiB、128 文件。可选 `integrity` 固定现有 bundle digest，不只是入口文件 hash。

省略 `sink` 默认 1 MiB；它只允许 `maxBytes`，范围为整数 1024–16777216。文件位置始终由 Service 派生，不会把模块配置解释为公开调用方路径。

## 选择 Profile

在调用方项目创建 `runtime.json`：

```json
{
  "schemaVersion": 1,
  "context": { "schemaVersion": 1 },
  "initialMiddlewareId": "service.continue.v1",
  "initialObserverIds": ["monitor"],
  "sandboxPolicy": {
    "schemaVersion": 2,
    "diagnostics": {
      "sourceReader": "none",
      "maxSourceReadBytes": 0,
      "observerEvents": ["script.compiled"],
      "maxQueuedEvents": 32,
      "maxObserverCallbackMs": 1000,
      "retentionMs": 0
    }
  }
}
```

创建 `index.mjs`：

```js
console.log('MANAGED_PROFILE_APP_OK')
await new Promise(resolve => setTimeout(resolve, 500))
```

```sh
holonomy run ./index.mjs --target native --capability-runtime ./runtime.json --detach
```

`run`、`test` 都这样选择。目标 Service 在远端时，调用方 CLI 仍需自己安装兼容 Native 二进制做源预检，不需要也不会取得服务端私有诊断模块。示例计时只为短暂保活，不保证有损事件一定投递。

每个所选 profile 都重新与本次 Policy、真实 Native descriptor、Host cap 校验。未知 ID、缺少 Native 安装、只有 Node 绑定、不支持事件、预算不足或版本不符均在 Guest 入口前拒绝。只安装 registry 不会启用 profile，空 ID 列表不暂存它；Node/Android 保留各自规则。

## 快照、代际与输出

Service 启动时冻结源码/config/注册/sink 限额并计算规范版本 digest。修改文件不会改变正在运行的 Service 安装，需 owner 重启。进程请求会私下固定所选版本；Service 重启后，改变或缺失的 profile 不会悄悄替换旧请求代码，使用新安装应创建新的准入请求。

每一代进程都有独立私有模块资源和输出。默认 Service state 布局下，owner 可查看：

```text
HOLONOMY_HOME/state/native-processes/<processId>/g<generation>/host/observer-output/monitor.jsonl
```

这是 owner 文件系统位置，**不是**公开 API 或 Guest 路径；自定义 state 目录会改变物理前缀。公开进程/operation DTO 和普通日志不暴露源码/config、安装位置或 sink 路径。本轮不添加远程事件导出 endpoint，也不把记录混入 Guest stdout。

普通插件数组 watch 不改变 profile 选择和资源。重启使用新代际资源与 sink session，移除进程沿用既有自有代际清理。输出为 best-effort，满载/终止清理可丢失，见[独立 Profile 限额与记录格式](observer-profiles.zh-Hans.md#私有输出)。

## 清理示例

Detached 命令返回进程 ID。删除进程前先保存需要的私有输出；删除也会清理其自有 Native 代际文件。进程仍在运行时，先用 `holonomy process stop <process-id>` 停止，再执行：

```sh
holonomy process remove <process-id>
holonomy service stop --drain
```

最后一条命令仅用于本例隔离的 `HOLONOMY_HOME`，不要 drain 其他应用共享的 Service。

模块仍只在无业务能力、同二进制辅助进程执行，使用期限、有界重启和 owner EOF 清理。原 inline 闭包仍为 partial，不序列化、不迁移。SourceReader、持久源审计、Device、Process 均是独立安装。当前真实证据为 macOS arm64，不代表完整 Native/M4、所有平台或正式发布验收。
