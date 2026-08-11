# Holonomy Service

[English](./README.md)

Holonomy Service 是 CLI 共享的机器级常驻控制面，统一负责设备清单、Runtime 进程生命周期、
日志与事件、网络规则代际、Inspector lease 和带鉴权的 OpenAPI。CLI 只连接 Service，不在自身
进程里临时托管 Android 或 Node Runtime。

## 稳定调用入口

```js
import {
  createHolonomyServiceClient,
  ensureHolonomyServiceProcess
} from './tools/service/index.mjs'

await ensureHolonomyServiceProcess({ environment: process.env })
const service = createHolonomyServiceClient({ environment: process.env })

const admitted = await service.launchProcess(snapshot, crypto.randomUUID())
const processId = admitted.value.process.id
await service.readLogs(processId, { after: 0, waitMs: 1_000 })
await service.processAction(processId, 'restart', 1, crypto.randomUUID())
await service.processAction(processId, 'resume', 2, crypto.randomUUID())
await service.processAction(processId, 'stop', 2, crypto.randomUUID())
await service.removeProcess(processId, 2, crypto.randomUUID())
await service.openInspector(processId, 2, crypto.randomUUID())
await service.replaceNetworkRules(
  processId,
  rules,
  currentRevision,
  crypto.randomUUID()
)
```

`ensureHolonomyServiceProcess()` 会把 `entry.mjs` 作为独立后台进程启动并等待健康检查。
本地状态位于 `HOLONOMY_HOME`（默认 `~/.holonomy`），endpoint、token、state、journal 分开保存；
token/owner 文件权限为 `0600`，目录权限为 `0700`。

显式远程模式不会自动启动本地 Service，也不会静默回退：

```js
const remote = createHolonomyServiceClient({
  openapiUrl: 'https://runtime-host.example/openapi.json',
  tokenFile: '/absolute/path/holonomy.token'
})
```

对应环境变量为 `HOLONOMY_OPENAPI_URL`、`HOLONOMY_OPENAPI_TOKEN_FILE` 和
`HOLONOMY_OPENAPI_TOKEN`。非 loopback 监听必须启用 TLS 并精确校验配置的 Host；不开放 CORS。

OpenAPI 3.1 位于 `/openapi.json`；全局 SSE 位于 `/v1/events`，进程 SSE 位于
`/v1/processes/{id}/events`；场景 skill 位于 `/.oo/skills/index.json` 和
`/.oo/skills/{scenario}/SKILL.md`。Inspector admission 返回进程级 `webSocketDebuggerUrl`；
非 Network CDP 透明转发，Fetch diagnostics 由 Service 有界映射为 CDP Network 事件。映射包含
请求/响应 ExtraInfo、脱敏后的实际 Headers、Fetch 层 timing、传输大小、配额内 response body，
并明确区分真实请求与 Mock。Mock 不伪造远端地址或 TLS；真实目标本身是 IP literal 时会显示该地址，
DNS/socket/TLS 分段信息则只会在可信原生 transport 提供后显示。
Runtime stdout/stderr 由 Service 自有的有界日志存储保留 24 小时；SSE 发布可续传 cursor 的
`process.output` 摘要，实际日志 chunk 不在事件仓库重复存放。

进程资源的 canonical 路径是 `/v1/processes/{id}/inspector-leases` 与
`/v1/processes/{id}/network/rules`。所有有副作用 mutation 都必须携带 `Idempotency-Key`，结果保留
24 小时；`devices:refresh` 明确定义为只读观测刷新例外。Skill reference 只允许从
`/.oo/skills/{scenario}/references/{safe-name}.md` 读取，并校验普通文件、realpath、symlink 和大小。

Android 首次只通过 app-private session-v2 ingress 唤醒 daemon，之后发现 owner-private endpoint
并由 Service 独占管理 ADB forward。Node 为每个逻辑 Runtime 维护独立 `NodeRuntimeSupervisor`。
没有 Android SDK/ADB 的机器仍可独立使用 Node target；并发容量由 adapter 决定，不由 Service
registry 人为限制为单进程。Android `isolatedProcess` 当前稳定返回
`process.isolation_unsupported`，不会静默退化为逻辑隔离。Service 也能启动已安装 AVD，并持久化
owner nonce、launcher PID、AVD 名和 serial；stop/restart 前会从正在运行的 emulator 查询 nonce，
因此不会误停外部 emulator 或真机。daemon 恢复时会 stop/dispose 遗留 Android Runtime；设备离线
时先将其代际标为 lost，待 watcher 发现设备恢复后继续清理。
