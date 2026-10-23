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

Native target 需由 Service owner 显式安装：在 `HOLONOMY_HOME/native-runtime.json` 写入
`{"schemaVersion":1,"executablePath":"/绝对路径/holo"}`，文件权限设为 `0600`。
可执行文件须由当前 owner 持有、为普通可执行文件，且不得是符号链接或允许 group/other 写入；
规范路径的祖先也须可信，不接受可被不可信用户替换的目录。
同一 owner-only 文件可显式安装 `diagnosticSourceReader`，每次运行仍须独立取得 `boundedSource` Policy。默认 `metadataOnly`/`none` 运行不提供 reader，Node 回调配置不能授权 Native 读取。精确配置和限额见[受管 Native Engine Gate](../../adapters/desktop/managed-engine-gates.zh-Hans.md#可选的-host-only-源码读取)。reader 绑定和原始源码均为私有数据，不进入公开进程状态。
独立可选的 `diagnosticAudit: {maxBytes}` 安装可[在 Native 返回源码副本前同步写入有界元数据](../../adapters/desktop/managed-source-audit.zh-Hans.md)，本身不授予读取权限。只有选中 boundedSource 的运行才获得 Service 生成的每代私有 sink，不增加公开输入路径或事件导出 API。
Native [Observer 插件](../../adapters/desktop/observer.zh-Hans.md) 按真实 Native 支持描述调用 `ctx.holo.observe` 注册，Service Node 回调 ID 不能安装 Native 回调。这是部分 Host-only 元数据投递，不代表外部遥测 sink 或独立同步回调隔离。
需要独立执行时，owner 可在单独的 `HOLONOMY_HOME/native-observer-profiles.json` [安装 Native 诊断 Profile](../../adapters/desktop/managed-observer-profiles.zh-Hans.md)。Native `initialObserverIds` 只选择这些不可变资源，不能提交模块、回调或输出路径。Guest 入口前复核 Policy、支持和版本；输出属于每代私有资源，不是公开事件 API。Node 回调绑定仍独立。

Native CLI 也需要此本地安装进行源预检，即使目标 Service 在远端；前端和 Runtime 版本应兼容。准备过程使用二进制的私有只读源 helper，不启动 V8 或执行插件；先捕获原始 Host/Guest 角色，再进入 Service 暂存，CLI watch 期间保留租约，并复用共享解析器收集实体包元数据。Service 发送的是自己的私有执行工作区，不是调用方原始文件系统路径。已认证 Host 仍对自己主动发布的数据负责，这不把任意 Host 发布改称不可信 Guest 输入。
`holonomy run ... --target native` 与 `holonomy test ... --target native` 提交冻结的
`app://workspace/` 模块图；Service 将精确源码写入每代私有目录，通过私有 owner-EOF 入口
运行所选 Rust 二进制。Native 读取模块前按完整逻辑 URL allowlist 检查。
Host Policy、Context 与已安装的文件系统根位于 Guest 源码目录之外。Native Inspector lease 已支持 enabled/break，通过真实 Native Gate 授权；见 [Native Inspector 指南](../../adapters/desktop/inspector.zh-Hans.md)。
Network Rules、fixture 与公开环境字段目前在 admission 阶段拒绝。Service 异常退出会
关闭控制管道，让 Native 代际自行取消；恢复时只观察已记录的 PID，未知或被复用的存活 PID
继续保留 cleanup pending，不扫描并杀死进程。

Native `run`/`test` 接受与 Node 相同的有界 `holo-plugins:///` Bundle。CLI `--config` 在调用方 workspace
构建资源；可选的 package config Schema 参与 Bundle 摘要，并由 Native Host 再校验。运行中的 `run`
可按 expected generation/revision 更新插件数组，不重启 Guest；只有收到私有 Native 应用确认后才推进
Registry revision。明确拒绝保留旧图，确认超时或 EOF 导致结果不明时停止该 generation，无法回收则保留
cleanup pending。每代暂存最多 256 个 revision、256 MiB。内部观察不让短脚本长驻，显式 CLI `--watch`
才保活；这仍是配置 watch，不是任意源码文件 HMR。

Native 日志暂存每记录最多 2 MiB，全局最多 16 MiB/8,192 条；每页序列化数据最多 512 KiB。
游标缺口会输出固定的丢弃标记，持久日志仍由既有 ServiceLogStore 管理。删除与保留期清理先
释放精确代际，Registry 确认移除后才清整个进程目录；最终清理失败时，在同一 state journal
保留待清理凭据，并于启动或维护时重试，不丢失所有权证据。

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
