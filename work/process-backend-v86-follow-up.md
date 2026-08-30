# Process Backend v86 后续支持与验收

本文承接 [v86 验证与开发任务](process-backend-v86-development-plan.md) 的后续轨道与发布门禁。

## 插件与配置

- v86、agentOS、WASIX 分别作为独立 Cordis/Backend 插件包；
- CLI/Host 将 npm、相对路径、允许的绝对路径转换为 `holo-plugins:///*` 资源；
- `holo.config.json --watch` 只在新配置通过 JSON/Schema、资源 digest 和 Backend admission 后切换；
- diff 卸载旧 scope、装载新 scope，失败保留 last-known-good graph；
- Backend 选择和默认 environment 仍由 Host profile 决定，插件配置不能扩大 SandboxPolicy。

## 候选 Backend 恢复条件

1. agentOS 在共享 descendant/lifecycle 接口稳定后恢复，首期仅实现 Node/Desktop 的 process、stdio 与 FS；network、snapshot、Android 保持 unsupported。
2. WASIX 在 agentOS 增量之后评估，且必须先解决或受控修补当前 SDK 序列化回归，并证明 Worker、process tree 和 generation close 不残留；首期只接收摘要绑定的 WASI/WASIX workload。
3. 两者分别拥有 Host 安装清单、descriptor、Broker re-entry、generation fencing 与真实 E2E；不得借用 v86 或 Native Darwin 的证据。

## Desktop 验收

- VM cold/warm boot、runtime/processTree scope、spawn/execFile/exec feature detection；
- stdout/stderr/stdin backpressure、exit/error/close、timeout/abort/signal；
- process-tree cleanup、VM crash、Runtime restart、Plugin unload/reload；
- FS snapshot/writeback/rollback 与 Network curl/git denial/allow；
- Inspector 关闭边界、无 Host path/PID/credential 泄漏；
- 同一证据重复运行的 artifact/source revision 与指标上限稳定。

当前完整 FS、Network、插件注册和 lifecycle 尚未全部通过，Backend 仍为 Experimental 且非默认。

## Android emulator 验收

- 可信 Loader 校验失败时 Guest entry 副作用为零；
- VM boot、命令、stdio、exit、FS、Network 与 generation fencing；
- activity/process recreation、Runtime stop/restart、Backend crash；
- 单 VM 与并发 VM 的 RSS、启动时长、主线程无阻塞/ANR；
- 结果明确标记 `emulator`，不写成物理设备验收。

## 发布条件

- 完成真实 Backend 注册和对应平台 E2E 前，公开支持矩阵继续标记“未安装/Experimental”；
- v86 的 Desktop 通过不能自动声明 Android；Android emulator 通过也不能声明物理设备；
- agentOS/WASIX 只按各自真实二进制、网络、生命周期边界发布，不借用 v86 证据；
- 每次新增支持组合都更新双语文档、OpenAPI/CLI 配置说明、machine evidence 和独立复审。
