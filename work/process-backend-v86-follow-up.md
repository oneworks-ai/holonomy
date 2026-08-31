# Process Backend v86 后续支持与验收

本文承接 [v86 验证与开发任务](process-backend-v86-development-plan.md)，只记录当前 Experimental v86 的支持升级边界。agentOS 和 WASIX 不在当前排期。

## 当前已闭合

- Node/Desktop 与 Android emulator 都通过 Host 安装清单加载摘要绑定的 BIOS、kernel、initrd、v86 WASM 和软件清单；损坏资产在 Guest entry 前拒绝。
- 公开 `node:child_process` 经过 Process Policy、CanonicalResource、Cordis Middleware、Provider authority 和 generation-bound resource protocol。
- `runtime` 与 `processTree` scope 由 Host profile 决定；Guest 只能通过 `holo:runtime` Symbol 请求允许集合内的 scope。
- `agent` 镜像可复现地产出 manifest、SPDX SBOM 和 executable allowlist，并包含 shell、cat、curl、git、ssh、jq、nc、timeout。
- Linux FS、TCP/UDP/DNS、Host Device/System projection 和后代 `execve` 准入均使用版本化 Host↔Guest 通道；Guest 最终重校验 notification/syscall，并以 `/proc/<pid>/exe` 的规范路径、设备号、inode 确认目标真实替换后，才通过 `execResult` 提交 executable identity。实际 `exec` 失败、拒绝或迟到决定不会污染后续归因；不存在 ambient Host 权限回退。
- 后代 socket 由 Guest gate 上报实际 PID/PPID/starttime，Host 绑定已提交 executable identity；DNS preflight/verify 使用共享 resolution challenge，传输层只连接 token 中未过期的 admitted address，地址集合变化稳定拒绝。
- Node production v86 已在旧 generation 持续写 heartbeat 时执行 Runtime restart，并证明进程树停止后 generation 2 使用全新 VM；Android emulator 也通过公开 Runtime restart conformance。
- Android 破坏性故障矩阵直接验证 VM/backend 异常退出只交付一次 process error/close、TCP peer 断连只交付一次 end/close 并释放 socket 配额、输出上限只选择一次 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` 与一次 SIGKILL/close terminal。
- Guest gate conformance 已真实证明绝对 `execveat` allow，以及相对路径、非 `AT_FDCWD` dirfd 和 `AT_EMPTY_PATH` fail closed。
- `holonomy run --watch` 已通过真实 CLI 进程、真实 Service 和真实 Cordis graph replacement E2E；无效候选保留 last-known-good revision，SIGINT/SIGTERM 后 watcher 与 Service Runtime 均被清理。

## Experimental 加固

这些事项提升 v86 的证据和可诊断性，但不改变 Stable Native Darwin 已满足核心 M3.5 Exit 的事实：

1. 补 snapshot/writeback/rollback profile；当前 production descriptor 正确声明 `snapshots: false`。

## 支持等级晋升

v86 保持 Experimental，直到拟发布范围取得以下独立证据：

- Android 物理设备，不借用 emulator 结果；
- 若声明 64-bit 或 multicore，分别使用真实对应 VM/内核证据；当前只声明 x86-32、单核；
- 安装、卸载、损坏资产、Host 重启和版本回滚演练；
- 冷启动、稳态内存、并发 environment 和输出/网络/文件配额上限；
- 双语支持矩阵只列实际通过的 Host/Engine/Backend/System 组合。

## 非当前排期

- agentOS、WASIX、Windows Process/System Adapter 和非 V8 Desktop Engine 只保留已有研究代码与证据。
- 重新启用候选 Backend 必须先有新的设计决定、安装描述符、Broker 重入、generation fencing 和目标平台真实 E2E；不得借用 v86 或 Native Darwin 证据。
