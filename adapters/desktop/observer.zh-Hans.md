# Native Runtime Observer（部分支持）

[English](observer.md) · [Host 配置](host-configuration.zh-Hans.md)

本指南描述可信 Host Cordis 插件内 **inline** Observer 回调。需要独立、无业务能力的 helper/isolate 和有界私有输出时，使用实验性[独立诊断 Profile](observer-profiles.zh-Hans.md)。两种模式都不向 Guest 暴露 Observer API，也不输出授权决定。

## 独立入口

创建 `host.json`：

```json
{
  "schemaVersion": 1,
  "sandboxPolicy": {
    "schemaVersion": 2,
    "diagnostics": {
      "sourceReader": "none",
      "maxSourceReadBytes": 0,
      "observerEvents": ["script.compiled", "runtime.terminated"],
      "maxQueuedEvents": 16,
      "maxObserverCallbackMs": 50,
      "retentionMs": 0
    }
  },
  "plugins": [{ "id": "monitor", "use": "./monitor.mjs" }]
}
```

创建 `monitor.mjs`：

```js
export default ctx => {
  const recent = []
  ctx.holo.observe({
    acceptHighCost: true,
    events: ['script.compiled', 'runtime.terminated'],
    maxQueuedEvents: 16,
    callbackTimeoutMs: 50
  }, event => {
    if (recent.length === 16) recent.shift()
    recent.push(event)
  })
}
```

本例只在 Host 插件内存中有界消费元数据，不打印或导出事件。当前自包含 Native Host 插件环境未安装有界、Host-owned 的日志/事件导出通道或 ambient Host I/O；引擎提供 console 对象本身，不等于存在可用的输出 sink。开启 Observer Policy 或运行此示例，不等于已交付完整的可配置外部遥测 sink。普通 Guest stdout 不是 Observer 事件流。

在 `index.mjs` 写入 `console.log('OBSERVER_GUEST_OK')`，执行：

```sh
holo --timeout 3000 --host-config ./host.json ./index.mjs
```

预期 Guest stdout 为 `OBSERVER_GUEST_OK`。Observer 元数据不需要源码读取权限。插件请求超出 Policy、不支持的事件，或未设置 `acceptHighCost: true` 的高成本事件时，在 Guest 入口前安装失败。

## 受管 Native 入口

按[受管 Engine Gate](managed-engine-gates.zh-Hans.md#配置)在 owner-only Service home 安装 Native 二进制。同一个 `monitor.mjs` 配合仅含插件的 `holo.config.json`：

```json
{ "plugins": [{ "id": "monitor", "use": "./monitor.mjs" }] }
```

另建 `runtime.json`，沿用上例的 `sandboxPolicy`：

```json
{
  "schemaVersion": 1,
  "context": { "schemaVersion": 1 },
  "initialMiddlewareId": "service.continue.v1",
  "initialObserverIds": [],
  "sandboxPolicy": {
    "schemaVersion": 2,
    "diagnostics": {
      "sourceReader": "none",
      "maxSourceReadBytes": 0,
      "observerEvents": ["script.compiled", "runtime.terminated"],
      "maxQueuedEvents": 16,
      "maxObserverCallbackMs": 50,
      "retentionMs": 0
    }
  }
}
```

```sh
holonomy run ./index.mjs --target native --config ./holo.config.json --capability-runtime ./runtime.json
```

Inline Native 回调由 Host 插件在 Guest 入口前调用 `ctx.holo.observe` 安装。另可[安装 Service Native Profile](managed-observer-profiles.zh-Hans.md)，由 owner 私有模块资源和 `initialObserverIds` 选择；未知或仅有 Node 回调的 ID 会被拒绝。Node 绑定及限额不能授权 Native 订阅。插件数组 watch 清理卸载的 inline 订阅，不替换独立 Profile，也不扩大冻结的诊断 Policy。静态插件安装也适用于 `holonomy test`。

## 支持和限额

Service 准入与 Native Host registry 使用同一份 Native 平台描述，目前声明：

- optional：`script.compiled`、`script.execution-started`、`script.execution-finished`、`runtime.exception`、`runtime.terminated`。
- 脚本事件为高成本，订阅时必须显式 opt-in。
- unsupported：`gc.completed`、`memory.pressure`、`promise.rejected`。Native Service 在入口前拒绝这些 Policy 选择，不假装提供事件。
- Host 硬上限：队列 256 项、异步回调期限 1,000 ms。实际限额取订阅、Policy、平台和 Host 上限的最小值。省略订阅期限时继承该最小值；0、负数或小数均非法。

事件包含 `schemaVersion`、`event`、isolate 内的 `generation`、单调时间 `observedAt`、`sequence` 和闭集 payload。编译事件带虚拟 origin、脚本 ID、源码字节数/摘要，不带源码文本。执行事件覆盖显式 module/CommonJS 执行根，不覆盖每个隐式依赖或 eval/Function 调用。异常/终止事件只带固定 code/reason，不带 message、stack、body 或 Host Context。Native isolate 的代际从 1 开始；Service 进程代际是独立的外层生命周期身份。

投递有界且可能丢失。引擎队列最多 64 项、每条 owned message 最多 8 KiB，不占 Gate 命令队列容量。订阅 overflow 会合并计数；optional 事件及终止投递都可能丢失，不能据此断言完整 start/finish 配对或审计历史。close/dispose 后不再投递，异步回调也不延长 Guest 终止。

Observer 返回值不会直接成为 Gate 决定。但当前 inline 回调仍共享 Host 插件闭包状态，可以影响该插件后续的 Gate/Middleware 逻辑。因此 partial 实现未强制隔离监控与授权的相互影响；单靠回调返回类型或独立事件队列，不能证明这种更强隔离。

回调抛错或异步停滞只产生固定、无源码的诊断，如 `holo observer callback.failed runtime.terminated`，不记录私有异常文本。但 inline 同步无限循环可能无限阻塞可信 Host worker；只有显式 Runtime 期限、取消或其他致命 watchdog 条件触发时，才终止整个代际。独立 `holo` 默认没有期限，示例因此显式设置 `--timeout 3000`。**Inline 闭包不会因此获得独立执行器隔离。** 异步期限不能抢占同步 JavaScript，需要该边界应显式选择[诊断模块模式](observer-profiles.zh-Hans.md)，不能让 inline Observer 成为业务授权或可用性的必要前提。

[有界源码 reader](engine-gate.zh-Hans.md#有界源码读取)、其可选持久审计 sink 和 [Desktop Device](device.zh-Hans.md) 都是独立安装。此 Native 部分支持不代表完整 M4、Android/Windows 或正式发布验收。
