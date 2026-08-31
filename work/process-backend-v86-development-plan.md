# Process Backend v86 开发现状

## 目标与边界

`experimental.v86-v1` 是 Holonomy 的完整 Linux 实验 Backend。它复用公开 `node:child_process`
Facade、Process Policy、CanonicalResource、Cordis Middleware、Provider authority 和 HoloUV 资源生命周期，
不向 Runtime JS 暴露 Backend、镜像、Host path、真实 PID 或凭据。

核心 M3.5 已由 Stable Native Darwin Backend 满足。v86 的工作用于扩展 Node/Desktop 与 Android 的
Linux 能力和支持等级，不反向把核心 M3.5 标成未完成。agentOS、WASIX、Windows Adapter 与非 V8
Desktop Engine 只保留研究证据或扩展点，不在当前开发排期。

## 当前支持矩阵

| 组合                                    | 状态         | 已验证范围                                                                                    |
| --------------------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| macOS + Node/V8 + Native Darwin         | Stable       | 真实 CLI、Process authority、stdio、timeout/abort/signal、进程树清理                          |
| macOS + Node/V8 + v86/Linux             | Experimental | 摘要绑定资产、shell/工具、FS、TCP/UDP/DNS、Device/System、后代 `execve`、公开 Facade 控制语义 |
| Android emulator + Javet/V8 + v86/Linux | Experimental | 同一生产 Backend、FS、TCP/UDP、Device/System、后代准入、公开 JS conformance                   |
| Android 物理设备 + v86/Linux            | 未声明       | 尚无物理设备证据                                                                              |

当前 v86 只声明 x86-32、单核、无生产 snapshot。Android Host 在第一个 V8 isolate 前选择
Liftoff-only 编译档位并默认关闭 v86 JIT；Desktop 不继承该降级。

## 已完成实现

### Host 安装与镜像

- Host 安装描述符固定 v86 WASM、BIOS、Linux kernel、initrd、镜像清单与 SHA-256；损坏、缺失、平台
  不兼容均在 Guest entry 前失败。
- `minimal`、`base`、`agent` 和 strict `custom` profile 由 Host 选择；`agent` 镜像包含 shell、cat、
  curl、git、ssh、jq、nc、timeout，并生成 SPDX SBOM 和 executable allowlist。
- 生产镜像不包含 conformance selftest，也不会在 Runtime 启动时联网安装工具。

### HoloUV 与 Process

- `packages/holouv/` 统一 environment、request/handle、process/stream、generation、关闭和迟到终态语义；
  Native Host OS Adapter 与 v86 Guest System Adapter 可以使用不同底层实现。
- v86 中 `/sbin/holo-uvd` 通过有界版本化 frame 提供 spawn、stdio、exit、signal、FS、Network、
  Device/System 与后代执行准入；wire protocol 不暴露 `uv_*` 内存 ABI。
- `runtime` scope 复用 Host 管理的 environment，`processTree` scope 隔离创建；默认值和允许集合只由
  Host profile 控制，Runtime JS 只能通过 `holo:runtime` Symbol 请求允许的 scope。
- public `spawn`、`execFile`、`exec` 已覆盖 callback tuple、ChildProcess 立即返回、stdout/stderr
  backpressure、timeout、AbortSignal、signal、close 和 generation-bound cleanup。

### Linux 能力桥

- Linux FS 使用 `holo-fs://` authority，覆盖准入后的 read/write/open/stat/readdir/mkdir/rename/
  unlink/watch 与句柄/流/配额语义；没有 ambient Host path 回退。
- Linux TCP、UDP 和 DNS 进入 `host.process.network`，与 JS Fetch 共用 Network Policy owner，但保持
  不同 operation/resource；endpoint、private network、socket/byte limit 由 Host profile 决定。
- Host Device/System 只把已选择的字段、模式、精度和 revision 投影进 Linux；未提供字段保持
  unavailable，不从虚拟硬件或 `/proc` 反推 Host 隐私。
- 后代 `execve` 在 Linux 内核边界暂停，上报 generation、environment、PID/PPID/starttime、path、argv
  和 cwd；Host 重跑 Process authority 后返回 allow/deny。Guest 在真正继续前再次校验 seccomp notification 与
  syscall 快照；内核接受继续执行后，再以 PID/start time 与 `/proc/<pid>/exe` 的规范路径、设备号、inode
  确认目标真实替换成功，并回传 `execResult`。Host 只有收到 `committed=true` 后才更新该 PID 的
  executable identity；通知过期或实际 `exec` 失败保持原调用者身份。
  未知、相对、可变、超时或迟到目标 fail closed，且不能留下伪造的目标程序归因。
- test-only Guest gate conformance 已真实执行绝对 `execveat` allow，并证明相对路径、非 `AT_FDCWD`
  dirfd 与 `AT_EMPTY_PATH` fail closed；生产镜像仍不包含该 fixture。

### 装配与开发体验

- Node/Desktop 与 Android 使用同一 Process Backend Registry/SPI；Android 只替换 Host transport 和
  平台资源装载。
- Runtime 从 `holo-plugins:///*` 加载 Cordis 插件；`holonomy run --watch` 对合法配置 diff 执行插件
  卸载/装载，无效候选保留 last-known-good graph revision；SIGINT/SIGTERM 会先关闭 watcher，再停止并移除
  Service Runtime。一次性 entry 由 CLI wrapper 保活，测试不依赖应用自己创建 timer。
- 真实 CLI E2E 同时覆盖 Cordis graph replacement、Permission 插件 allow/deny、`node:os` 和 Native
  Darwin `node:child_process`，不是只调用内部 helper。

## 当前加固状态

以下事项属于 v86 Experimental 加固，而非核心 M3.5 blocker。前三项已经闭合；后两项只有在扩大支持声明时才进入实现：

1. 后代 TCP/UDP 现已由 Guest kernel gate 采集实际 PID/PPID/starttime，并在 Host transport 消费前绑定到
   已提交的 executable identity；不能再用 environment root 冒充 socket 来源。
2. Process DNS 现已复用共享 resolution challenge：Provider preflight 产生 canonical address set、resolver
   generation、TTL 与 evidence digest；verify 检测 rebinding，transport 只消费 admitted address。
3. Node production v86 现已用活跃 heartbeat process tree 执行破坏性 restart，并证明旧 generation 停止写入；
   Android emulator 从同一公开 JS conformance 重新创建 generation 2。Backend crash/dispose 的 exactly-once
   单元与 Provider race vectors 继续作为常规回归门禁。
4. snapshot/writeback/rollback 仍未实现；在此之前 descriptor 保持 `snapshots: false`，也不能把 initial-state
   boot 解释成 VM snapshot。
5. 若要晋升支持等级，补 Android 物理设备、安装/卸载/损坏资产/回滚、冷启动/稳态内存/并发上限；
   64-bit 或 multicore 必须分别取得真实 VM/内核证据后才能声明。

## 验证入口

```bash
pnpm test:m35:v86:node
pnpm test:m35:v86:android
pnpm test:m35:v86:guest
pnpm test:m35:v86
pnpm test:cli
pnpm test:service
pnpm test:adapter:node
pnpm test:adapter:android:unit
pnpm contracts:check
pnpm docs:check
pnpm typecheck
pnpm lint
pnpm format:check
pnpm rfc:check
```

真实 acceptance 必须使用生产资产根并验证 artifact digest；Guest gate conformance 还需通过
`HOLO_V86_ZIG_PATH` 指向锁定的 Zig `0.16.0`。普通单元测试、模拟 Provider 或 stock v86 设备行为
不能替代 Node/Android 公开 JS conformance；`guest` 子命令只补充内核/daemon 私有 fixture 证据。

更细的支持晋升条件见[后续支持与验收](process-backend-v86-follow-up.md)。
