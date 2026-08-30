# Android 平台

[English](../../en/platforms/android/index.md)

Android 使用非 UI foreground Supervisor 管理多个逻辑 V8 Runtime。每个 Runtime 拥有独立 engine、runtime thread、generation、NativeHost、输出 sequence 和 Inspector socket。

Service 负责 ADB 设备发现、安装、command-v2 传输、forward/reverse、日志消费和恢复。设备侧不开放 TCP 控制端口；完整命令保存在应用私有目录，exported 兼容入口只接收随机 command ID。

当前隔离模式是 `runtime`，即同一 Android 应用进程内的逻辑 V8 隔离。`isolatedProcess` 会稳定返回 unsupported。

网络 Provider 独立执行 authority、DNS 地址准入、socket/TLS、配额、取消和流式 credit。Fetch、redirect、Request、Response 与 Abort 语义仍由共享 JavaScript Runtime 负责。

Android 支持由 Host 在启动前提供 `holo-plugins:///` Bundle。Javet 使用 Host 生成的只读静态 plugin manifest，在独立于 Guest 的 Host V8 realm 中同步完成 Cordis Context 安装；插件 global 对 Guest 不可见。返回 Promise 的异步初始化会在 Guest entry 前稳定失败。当前不支持 Capability interception、运行中插件图替换或 `--watch`。

实验 v86 由可选生产模块 `process-backend-v86` 提供。Android Host 在 Runtime 创建时装配
`AndroidV86RuntimeServicesFactory`；Process Policy 为 `none` 时不会读取资产或创建额外 V8，选择
`experimental.v86-v1` 且为 `sandboxed` 时则自动启用进程级 Liftoff-only flags，并创建 generation-owned
可信 V8/Linux VM。资产由 `-Pholonomy.v86.assetsDir` 或 `HOLO_V86_ANDROID_ASSET_ROOT` 显式打包，核心
Android 模块不会无条件携带约 37.9 MiB raw `agent` Linux 资产。

模拟器已通过标准 `node:child_process` facade 验证生产 Capability Host 的 Linux PID 归因 `/workspace`
FUSE 目录操作、pre-spawn stdin、stdio/退出、TCP/UDP/DNS、Device/System 投影、后代执行前 allow/deny 与
restart 新建 VM。instrumentation APK 只是安装在被测应用旁边、由 AndroidJUnitRunner 启动测试的独立
测试包；实际被测 Backend 来自生产 AAR。该组合仍是 Experimental，也尚未声明物理设备支持、
`/workspace` 之外的 POSIX 文件面、64-bit、multicore 或真正的 VM snapshot/restore。

模拟器与物理设备使用同一产品路径，但验收报告必须分别标记；模拟器通过不能写成物理设备通过。

更多信息：[Session Host](../../../../adapters/android/session-host/README.zh-Hans.md) · [Network Provider](../../../../adapters/android/network-host/README.zh-Hans.md)
