# Android 平台

[English](../../en/platforms/android/index.md)

Android 使用非 UI foreground Supervisor 管理多个逻辑 V8 Runtime。每个 Runtime 拥有独立 engine、runtime thread、generation、NativeHost、输出 sequence 和 Inspector socket。

Service 负责 ADB 设备发现、安装、command-v2 传输、forward/reverse、日志消费和恢复。设备侧不开放 TCP 控制端口；完整命令保存在应用私有目录，exported 兼容入口只接收随机 command ID。

当前隔离模式是 `runtime`，即同一 Android 应用进程内的逻辑 V8 隔离。`isolatedProcess` 会稳定返回 unsupported。

嵌入自己的 Android App 时使用生产 [`runtime-host` 源码 SDK](../../../../adapters/android/runtime-host/README.zh-Hans.md)，而不是 E2E APK。它打包共享 Runtime 与生产 bootstrap，不携带测试控制器、fixture 或 Linux 镜像。要求 API 29+、JDK 17、SDK 35 和固定 Javet 5.0.10；AAR 不是包含全部传递依赖的单文件 SDK。

Host 可以逐 generation 显式安装 `crypto-host`，提供同步 SHA-1/SHA-256、HMAC-SHA-256、AES-256-GCM、随机数和定时安全比较；默认不安装。另可安装 [`storage-host`](../../../../adapters/android/storage-host/README.zh-Hans.md)，通过共享 Policy/Broker 与异步原生 worker 提供持久二进制 KV。KV 默认 namespace 为 `default`，SQLite 和凭据仍不支持；添加模块不自动授予权限。两者已在 API 35 arm64 模拟器的生产 bootstrap 中运行共享 JS 合同及 generation 重建测试，不代表物理设备验收。

网络 Provider 独立执行 authority、DNS 地址准入、socket/TLS、配额、取消和流式 credit。Fetch、redirect、Request、Response 与 Abort 语义仍由共享 JavaScript Runtime 负责。

Android 支持由 Host 在启动前提供 `holo-plugins:///` Bundle。Javet 使用 Host 生成的只读静态 plugin manifest，在独立于 Guest 的 Host V8 realm 中同步完成 Cordis Context 安装；插件 global 对 Guest 不可见。返回 Promise 的异步初始化会在 Guest entry 前稳定失败。静态同步插件可以拦截 Capability 调用；当前不支持运行中插件图替换或 `--watch`。

`v8-host` 为固定的 Javet 5.0.10/V8 ABI 提供窄 Engine Gate JNI bridge。应用通过
`RuntimeEngineFactory.create(engineGateFactory = ...)` 为每个 generation 注入新的 Host Gate；bridge 在真实 V8
字符串与 Wasm 编译 callback 中同步提交源码摘要和安全副本，拒绝或 Host 异常都会 fail closed。它不读取 Javet
私有对象布局，也不包含授权 UI。模拟器已验证逐次 allow/deny、拒绝后生成代码副作用为零，以及 restart 关闭旧
Gate 并绑定新 generation；未声明支持的 Loader、Inspector 或 Observer 项仍按 Android capability descriptor
保持 unavailable。

实验 v86 由可选生产模块 `process-backend-v86` 提供。Android Host 在 Runtime 创建时装配
`AndroidV86RuntimeServicesFactory`；Process Policy 为 `none` 时不会读取资产或创建额外 V8，选择
`experimental.v86-v1` 且为 `sandboxed` 时则自动启用进程级 Liftoff-only flags；每个 root child 在
`processTree` scope 独占一台可信 V8/Linux VM，共享 `runtime` VM 暂不开放。资产由
`-Pholonomy.v86.assetsDir` 或 `HOLO_V86_ANDROID_ASSET_ROOT` 显式打包，核心
Android 模块不会无条件携带约 37.9 MiB raw `agent` Linux 资产。

升级镜像已经通过 API 35 arm64 模拟器的共享 JS 13 项合同，覆盖标准 `node:child_process` facade、Linux PID 归因、`/workspace` FUSE、stdio、TCP/UDP/DNS、Device/System 投影及新 generation。它拒绝 Guest 后续 exec 与 fork/clone；旧镜像的后代 allow/deny 证据不能沿用为当前支持。物理设备仍未验收。instrumentation APK 只是安装在被测应用旁边、由 AndroidJUnitRunner 启动测试的独立
测试包；实际被测 Backend 来自生产 AAR。该组合仍是 Experimental，也尚未声明物理设备支持、
`/workspace` 之外的 POSIX 文件面、64-bit、multicore 或真正的 VM snapshot/restore。

模拟器与物理设备使用同一产品路径，但验收报告必须分别标记；模拟器通过不能写成物理设备通过。

更多信息：[Runtime SDK](../../../../adapters/android/runtime-host/README.zh-Hans.md) · [Session Host](../../../../adapters/android/session-host/README.zh-Hans.md) · [Network Provider](../../../../adapters/android/network-host/README.zh-Hans.md)
