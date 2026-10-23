# 独立 Native 诊断 Profile（实验性）

[English](observer-profiles.md) · [Inline Observer](observer.zh-Hans.md)

独立 Rust/V8 `holo` 可把显式选择的诊断模块放进辅助进程中的单个、无业务能力 V8 isolate。辅助进程使用同一个二进制，不依赖 Node，也不是另一套产品 Runtime/Provider。此模式不会移动或重新解释原有 `ctx.holo.observe` 闭包；那些回调仍在可信 Host 内 inline 执行，保留既有部分隔离限制。

## 配置

先创建 owner-private 输出目录：

```sh
mkdir -p ./private
chmod 700 ./private
```

创建 `host.json`：

```json
{
  "schemaVersion": 1,
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
  },
  "observerProfiles": [{
    "id": "monitor",
    "use": "./diagnostic.mjs",
    "export": "default",
    "config": { "minBytes": 0 },
    "registration": {
      "acceptHighCost": true,
      "events": ["script.compiled"],
      "maxQueuedEvents": 16,
      "callbackTimeoutMs": 1000
    },
    "sink": { "path": "./private/observations.jsonl", "maxBytes": 1048576 }
  }]
}
```

创建 `diagnostic.mjs`：

```js
export default (event, config, sink) => {
  if (
    event.event === 'script.compiled' &&
    event.payload.sourceBytes >= config.minBytes
  ) {
    sink.publish()
  }
}
```

创建 `index.mjs` 并运行：

```js
console.log('PROFILE_APP_OK')
await new Promise(resolve => setTimeout(resolve, 500))
```

```sh
holo --timeout 5000 --host-config ./host.json ./index.mjs
```

Guest stdout 为 `PROFILE_APP_OK`，Host owner 可查看 `private/observations.jsonl`。示例短暂保活，方便可选诊断工作推进；这段计时不构成投递保证。短程序可能在排队事件处理前结束。它是有损旁路，不是完整、持久审计历史。

## 模块与注册合同

- Profile 是 Host 配置，不是 Guest API。ID 为 1–64 字节的唯一安全标识符，最多四个。保留资源实例名 `observer.<id>`，不得与普通插件冲突。
- 源码复用 Native Host 插件资源准入与现有自包含 ESM/pnpm 子集。所选 export 明确是诊断 handler，**不是**普通 Cordis `apply`，不会在辅助进程重跑普通插件初始化。包可显式导出诊断入口，但任意现有闭包不能原样跨 isolate 保留词法状态。
- Handler 接收不可变 JSON event/config 副本和当次回调的 `sink`。不安装 Host Context、Gate、Provider、文件、网络、Node 或通用 Runtime API；拒绝字符串代码生成、Wasm、dynamic import。可返回 Promise，但辅助执行器没有通用 timer/network runtime。
- `sink.publish()` 不接受参数，只请求发布当前原始、已归一化、无源码的事件，不接收自定义 JSON、派生指标、配置、源码或 Error。每次回调最多接受一次请求，保留的旧 sink 会失效。只有回调在期限内成功完成后才写入 `event` 记录。
- 注册沿用 Policy ∩ Native descriptor ∩ Host cap 校验，脚本事件需显式高成本 opt-in。五类 Native optional 事件和 unsupported 项不变，见[支持范围](observer.zh-Hans.md#支持和限额)。
- 可选 `integrity` 固定现有 Runtime plugin **bundle** SHA-256，不是单一入口文件 hash。源码图按 Runtime 快照，helper 重启复用原字节，不重读改变的文件。config JSON 最多 64 KiB；诊断源码单模块 1 MiB、快照总量 4 MiB、128 模块，在传输/实例化前单独校验。

所有注册、schema/integrity 和源码图校验先于辅助进程的用户初始化；全部所选模块 ready 后才执行 Guest 入口。配置、权限、模块/export 或初始化失败，会拒绝启动且不执行 Guest。Host 准备阶段可能已创建显式请求的私有 sink 文件。

## 隔离、期限与生命周期

每个 profile 同时运行一个回调并使用有界队列；有效回调期限为 1–1000 ms。单次初始化上限 2000 ms，最多两次 helper 重启，Host readiness 总界为七秒。更早的显式 Runtime 期限或取消仍优先；独立入口本身默认没有总体运行期限。

超时或致命 VM 错误丢弃诊断 helper/isolate，不终止后再用 `CancelTerminateExecution` 恢复主 Host。helper 的 V8 heap 目标为 32 MiB，resident 内存按 256 MiB 采样监控，不是瞬时进程 RSS 硬保证。诊断四槽（含未 reaped 子进程）不占 schema validator 池。初始化/回调 token、epoch 和 sequence 隔离迟到结果；owner EOF、Runtime 停止及清理会撤销发布并终止自有 helper，回调不无限延长 Guest 终止。

Profile 在一次 Runtime 内不可变；普通插件数组 watch 不替换它，修改需新建 Runtime。原 inline Observer 和其他可信 Host 插件仍可影响或阻塞自己的 Host 授权逻辑；选择独立模块，不会隔离无关的 inline 代码。受管运行可由 owner 另行[安装 Service Native Profile](managed-observer-profiles.zh-Hans.md)，调用方用逻辑 `initialObserverIds` 选择。Node 函数绑定仍独立，不能安装 Native Profile。

## 私有输出

Sink 路径必须相对 `host.json`。父目录需已存在、owner-private `0700`，且经过可信、no-follow 祖先；普通 leaf 文件需 `0600`、单硬链接并独占锁。`maxBytes` 为 1024–16777216。畸形/不完整历史、不安全权限或身份变化会失败关闭；不截断、不自动轮转旧文件。并发 Runtime 应选择不同文件。

记录字段有 `schemaVersion:1`、随机 `sessionId`、安全整数的 session 内 `sequence`、本地 `generation:1`、`profileId`、helper `epoch`、Unix 毫秒 `observedAt` 与闭集 `status`。状态为 `event`、`callback.started`、`callback.failed`、`callback.timeout`、`queue.dropped`、`profile.disabled`、`initialization.failed`。回调记录可带原始 `sourceEvent`，drop 记录带计数；`callback.started` 表示已准备参数、即将调用用户函数，不是完成证明。

原事件最多 8 KiB，记录最多 16 KiB，sink 队列最多 64 条；满载合并计数、非阻塞丢弃。容量、I/O、历史或身份错误会停用输出并产生固定诊断，不扩大权限、不改变 Guest 授权。不增加模块源码、JS 错误文本/stack、Host Context、native PID 或输出路径。此输出为 best-effort，不是源码读取的同步持久审计。

模块、配置、sink 名称和 inode 在 Guest 加载前标记为私有，保护模块别名。但显式的普通 FS grant 仍可能暴露 Host 秘密，不能向 Guest 授予这些目录；相同 OS 用户下，文件 ACL 本身不是完整代码隔离。

当前真实证据为 macOS arm64。此模式为实验性，不代表完整 Native/M4 覆盖、Android/Windows 或正式发布验收。[有界源码 reader 及审计](engine-gate.zh-Hans.md#有界源码读取)仍是独立安装。
