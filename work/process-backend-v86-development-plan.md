# Process Backend v86 验证与开发任务

## 目标

在不改变 `node:child_process`、SandboxPolicy、CanonicalResource、Cordis Middleware 和 Host profile
职责的前提下，把 `experimental.v86-v1` 建成第一条“完整 Linux”实验 Backend：

- Node/Desktop 在 Host 拥有的 V8 环境中运行 v86；
- Android emulator 在可信 Javet/V8 Backend 环境中装载同一类 WASM 资源；
- `runtime` 与 `processTree` 两种 environment scope 都由 Host 默认值和允许集合控制；
- 文件、网络、设备/系统 Bridge 继续经过 Holo authority，不给 Linux ambient Host 权限；
- agentOS 与 WASIX 使用同一 Backend Registry/SPI 独立接入，但不伪装成完整 Linux。

## 当前任务视图

| 轨道                    | 当前证据                                                                                        | 下一出口                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 电脑 Node/Desktop V8    | 自定义 Linux、supervisor、进程/stdio/exit/signal、Holo FS Bridge 与后代 `execve` 准入已真实通过 | 补 Android exec channel、Network Bridge、完整 FS operation 与 lifecycle E2E     |
| Android 模拟器 Javet/V8 | v86/Linux/FUSE 帧与生产 Capability Host 归因读写已分别真实通过                                  | 实现 trusted Backend Loader，把两段串成单链，再补 Network 与 generation fencing |

当前开发顺序固定为：先收口电脑端公共协议和 Provider 语义，再只替换 Android transport；网络
在两端都作为独立安全轨道，不因 stock NIC 或 Linux 内 `curl` 能联网而视为完成。

后续 Backend 支持顺序固定为：v86 后代 `execve` 准入 → Native Darwin 后代控制可行性 → agentOS
Experimental 集成 → WASIX Experimental 集成。后两项保留现有 probe/evidence，但在各自前置条件满足前不继续实现。

## 已完成基线

### Desktop Node/V8

- v86 `0.5.432` 在 macOS arm64、Node `22.22.2`、V8 `12.4` 中 headless 启动官方
  Buildroot Linux 6.8 i686；
- shell、退出码、stdout/stderr、stock 9p 双向文件、stock NIC 下 Linux 内 `curl`/`wget`、save/restore
  均已真实通过；其中 stock 文件/网络只证明 VM 设备行为，不计为 Holo FS/Network Bridge；
- 冷启动约 `1.54s`，workload 约 `442ms`，峰值 RSS 约 `659MB`；warm state 到执行约 `57ms`；
- VM 内 framed supervisor 已真实完成 spawn、stdio、exit 与 signal；其 READY 握手实测 stock Linux 只具备
  `process` 与 `networkNamespaces`，缺少 FUSE、TUN、fanotify、cgroup 与 seccomp user-notification，所以
  stock 9p/NIC 行为不能作为逐进程 FS/Network Bridge 证据；官方镜像内核为 `6.8.12`，且未开放
  `/proc/config.gz`；
- 自定义内核基线固定为 stable Linux `v6.8.12` / `632428373bea7581869cb05dce40bef0d37793e3`；
  仓库 fragment 已在该 revision 上真实执行 `i386_defconfig + olddefconfig`，29 个 boot/FS/network symbol
  均保持 built-in；macOS arm64 已用受控 clang helper 完成完整 i386 `bzImage` 构建；
- 自定义内核 READY 握手已真实报告 `process`、`fuse`、`tun`、`networkNamespaces`、`cgroups`、
  `fanotify` 与 `seccompUserNotification`；
- 真实 FUSE self-test 已把 Linux 文件请求映射为 `holo-fs://workspace/*`，经 Capability Broker、
  Linux process source、`NodeFilesystemProviderV1` 完成 Host→Guest read 与 Guest→Host write；
- 最终电脑探针返回 `filesystemBridge: true`、进程退出码 `7`、`SIGTERM` 与完整 stdio；该结论只覆盖
  Node/Desktop，且只代表当前已验证的 read/write/stat/open/release 垂直切片。

### Android emulator

- APK 资产图可选装载 digest 约束的 v86、BIOS、Linux kernel 和 supervisor initrd；
- Javet/V8 在 `OneWorksApi35Visible` Android 15 arm64 模拟器内真实启动 v86、Linux 和同一 supervisor；
- 自定义 self-test 已完成 stdin、stdout、stderr、退出码 `7`，并通过 supervisor operation `14/15` 完成
  Host→Guest read 与 Guest→Host write 的真实 FUSE request/response；
- 共享 `LinuxFilesystemCapabilityBridgeV1` 已由 Android production Capability Runtime 绑定到
  `AndroidCapabilityHost`，模拟器验证了 Linux PID、synthetic process、executable 归因以及
  lookup/open/positioned read/release/create/positioned write/release；
- 官方普通 WASM 与 fallback WASM 都通过，普通 WASM 不劣于 fallback，因此不分发 fallback；
- Javet `5.0.10` 的默认 Turboshaft 在编译 v86 WASM 时发生过真实 native SIGSEGV；Host 在创建第一个
  V8 isolate 前固定 Liftoff-only 后连续通过，`disable_jit=true/false` 均约 `85–88s`，所以模拟器默认关闭
  v86 JIT；
- v86/FUSE 与 production Capability Host 仍是两条独立 E2E；trusted Backend Loader 尚未串起 VM frame 与
  Runtime Kernel，因此 Android machine evidence 的 filesystem 仍为 `notRun`。

### 其他候选

| Backend | 当前定位                           | 已验证                                                                   | 当前阻断                                                                               |
| ------- | ---------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| v86     | 完整 Linux reference candidate     | 两端 boot/stdio/exit/FUSE、Desktop Holo FS、Android production FS 语义桥 | Process Network、完整 FS operation、Android trusted Loader 单链集成                    |
| agentOS | Desktop virtual-kernel plugin      | process/runtime scope、stdio、FS                                         | WASM socket timeout、无 Android sidecar、无完整 snapshot                               |
| WASIX   | Desktop packaged WASI/WASIX plugin | 0.9 workload、stdio、exit、virtual FS                                    | 0.10 serialization regression、Worker 泄漏、无可靠 process tree/network/Android Worker |

机器证据位于 `tests/fixtures/process-backend-probes/`，并由
`process-backend-probe-evidence.spec.ts` 通过公共 normalizer 验证。

## 代码边界

```text
Host Application
  -> Runtime resource bundle (holo-plugins:///*)
  -> Holo Runtime / Cordis App
     -> Process profile plugin
     -> ProcessProvider
     -> ProcessBackend Registry
        -> experimental.v86-v1
           -> trusted VM environment
           -> in-guest supervisor
           -> FS / Network / Device-System bridge
```

- Native Host 只加载可信资源、创建 Runtime、提供原生端口和 Backend 能力；不提供 Native 插件 API。
- Runtime 自己从 `holo-plugins:///*` 加载 Cordis 插件并完成 graph revision、dispose 和 watch reload。
- 当前 v86 FUSE 垂直切片已进入 Holo Capability Broker middleware；把该链改由 Cordis 通用调用协议承载
  仍属于 Runtime 集成任务，在上游 waterfall `next()` once-only 语义进入可用版本前不作完成声明。
- Guest 只能使用标准 `node:child_process`，以及 `holo:runtime` 提供的 scope Symbol；不能选择 Backend、镜像、mount、network 或 credential。
- Backend configuration、镜像路径、Host path、真实 PID 和凭据只存在于 Host binding。

## 开发阶段

### V1-R：通用 Environment 与证据

- 固化 Backend probe schema、artifact identity、Host/V8 identity、指标和 11 项 capability observation；
- Backend Registry 区分 `native`、`virtual-machine`、`virtual-kernel`、`wasix`；
- Backend-owned executable locator 替代对 Host path 语义的隐式依赖；
- environment 拥有 generation、scope、resource cleanup、crash terminal 和 snapshot capability；
- 共享 Environment Factory 已区分 `runtime` 复用与 `processTree` 隔离，并接入 Node Child-like resource；
- supervisor 传输使用有界、canonical、u32 大端长度前缀 frame；串口 shell marker 只保留为 probe；
- 未安装、版本不匹配、平台不匹配在 Guest entry 前失败。

### V1-D：Desktop v86 Backend

- Backend 运行在 Host-owned worker/realm，不进入被执行脚本的 Realm；
- 校验 v86 npm artifact、WASM、BIOS、kernel/rootfs 与软件 manifest digest；
- 实现 VM 内 framed supervisor，使用独立 `ttyS1` 和 v86 公开 `serial_send_bytes`，提供 spawn、synthetic PID、stdio、exit、signal、process-tree cleanup；
- `runtime` scope 复用长驻 VM，`processTree` scope 创建隔离 VM 或恢复预热 snapshot；
- VM crash、Runtime restart、Plugin dispose 均 exactly-once 关闭资源并丢弃 late terminal。

当前已完成 Host-owned Node/V8 环境、framed supervisor、process-tree scope、stdio/exit/signal 与
late filesystem terminal fencing。尚需把 Backend Registry 注入正式 Service/Plugin 装配路径，并完成
runtime scope、warm snapshot、crash/restart/plugin reload 的正式 E2E。

### V1-F：文件 Bridge

- 使用仓库内 `kernel/holonomy-v86.fragment` 和 pinned clean Linux revision 构建、校验自定义 i386
  `bzImage`；FUSE、fanotify、9p/virtio 必须内建，READY 握手缺任一 Host-required capability 时在 entry
  前拒绝；
- Host profile 把已准入的 `holo-fs://<rootId>/` 映射到 Linux guest path；
- 默认使用 snapshot 导入，按 Host 配置选择 `none`、`onSuccess` 或显式 commit writeback；
- Linux 文件事件带 environment、synthetic PID、executableId 和 canonical resource 进入 Capability
  Broker；Cordis 负责插件装配和未来通用调用协议，但不是当前安全校验的替代品；
- 9p 只作为传输，不能代替 Policy、symlink/TOCTOU、quota 和 Provider 重验；
- 固定测试覆盖 read/write/stat/readdir/rename/delete、越界路径、旧 generation 和 rollback。

当前真实探针已覆盖 read/write/stat/open/release、越界 mount 拒绝、Host middleware 进程源匹配和
environment close 后晚到 response 丢弃。readdir/rename/delete、symlink/resolution challenge、quota、
snapshot/writeback/rollback 仍是本轨道的剩余验收项。

### V1-N：网络 Bridge

- 自定义 kernel 必须内建 TUN、network/PID namespace、cgroup 与 seccomp filter；逐 connect 的
  before-admission 首选 seccomp user-notification，TUN/netns 用于获准流量承载与配额；
- Linux DNS/TCP/TLS 使用 `host.process.network`，不伪装成 JS Fetch；
- supervisor 与虚拟 NIC/proxy 协作，把 connect 绑定到 environment、synthetic PID 和 executableId；
- 每个 DNS address、目标 IP/port、代理/redirect 都重新通过 system policy；
- Cordis 可以在同一插件中匹配 Fetch 和 Process Network，但上下文 operation/resource 保持不同；
- `curl`、`git`、包管理器都必须证明没有绕过 private-address、endpoint、socket 和 byte quota。

### V1-X：后代执行准入

- root `spawn`/`execFile`/`exec` 继续在启动前经过现有 Process Broker 与 Cordis Middleware；
- v86 Guest Agent 只负责结构化 transport，Linux 内核级 `execve` gate 才是后代进程执行前的不可绕过边界；
- gate 上报 generation、environment、PID、PPID、executable、argv digest、cwd resource 与 parent authority，Host 决定后才允许 `execve` 继续；
- timeout、Host disconnect、Runtime stop/restart 与未知 executable 必须 fail closed，旧 generation 的决定和迟到 frame 均无效；
- 固定 E2E 由已准入 shell 启动后代程序，分别验证 allow、deny、超时、深度/总进程配额、PID/PPID lineage 和后代文件/网络归因；
- Native Darwin 保留 root Cordis 准入与 Seatbelt 静态 tree containment。另行评估具备系统权限的 observe/authorize profile，但不得用 v86 证据声明 macOS 后代控制，也不得为了逐次回调放弃 macOS Mach-O workload。

Node/Desktop 首个垂直切片已经完成：supervisor 子进程安装 seccomp user-notification filter，root
`execve` 消耗既有 root authority，后代 `execve` 在内核中暂停并通过 operation 16/17 上报
`linuxPid`、`parentLinuxPid`、path、argv 与 cwd。Host 只把 profile 中 exact guest path 映射为
`executableId`，随后用内部 `holo:runtime.authorizeDescendantProcess` 重新进入 Process Policy、
CanonicalResource、Host Middleware 与 Provider authority recheck。未知 path 或任意 Host deny 都返回
`EPERM`，不执行目标文件，也不杀死仍可继续工作的 root environment。

真实 E2E 日志终态如下；测试入口是
`adapters/node/test/capability-process-v86-runtime.test.mjs`，被测代码由 Runtime JS 通过标准
`node:child_process` 启动，并非 Host 直接调用 fixture：

```text
DESCENDANT_DENIED
DESCENDANT_ALLOWED
DESCENDANT_HOST_DENIED
```

前两行来自同一 root：清单内 `/holo-selftest` 后代执行成功，未知 `/holo-denied` 在执行前失败；第三行
来自只拒绝 `authorizeDescendantProcess` 的 Host Middleware 场景。当前仍缺 Android operation 16/17、
Host-only gate timeout 配置、`execveat`/relative path、深度/总进程配额和可变文件 resolution/TOCTOU。
这些缺口保持 v86 descendant admission 为 Node/Desktop Experimental，不影响已完成的 root Process profile。

### V1-A：Android emulator v86

- 在 production `v8-host` 增加可信 Backend Loader，而不是把 VM 放进普通 Runtime script Realm；
- 由 APK/resource bundle 提供 v86 WASM、BIOS、rootfs 和 supervisor，逐项校验 digest；
- 明确补齐 v86 所需 timer、performance、typed array、事件调度接口；
- 先跑最小内存配置并记录 boot/workload/RSS/ANR，再决定 Android descriptor 的最大 VM 数和默认 scope；
- Android probe 使用 Host-owned `liftoff-only` V8 编译档位和 `disable_jit=true` v86 档位；普通 Runtime
  不能覆盖这些默认值；Desktop 不继承该降级；
- 复用 Desktop 的 supervisor、FS/Network protocol vectors；只把 Android transport 做成平台实现。

模拟器实施顺序：

1. [已完成] 在 `V86ProcessBackendInstrumentationTest` 中加入 supervisor operation 14/15 的 FUSE request/response；
2. [已完成] 用内存 Host handler证明相同 kernel/supervisor frame，并让共享 Linux FS bridge 经 production
   `capability-host` 独立完成归因 read/write；
3. [进行中] 在 production `v8-host` 建 trusted Backend Loader，把 VM frame直接绑定 Runtime Kernel；随后
   独立复算 canonical path、process source 与 generation，复跑越界、停止、重启和晚到 response；
4. 最后接 Network Bridge；完成前 Android descriptor 的 filesystem/network 继续为 evidence-limited。

插件/配置、候选 Backend 恢复顺序、完整验收矩阵与发布条件见[后续支持与验收](process-backend-v86-follow-up.md)。
