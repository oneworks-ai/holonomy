# Android 平台

[English](../../en/platforms/android/index.md)

Android 使用非 UI foreground Supervisor 管理多个逻辑 V8 Runtime。每个 Runtime 拥有独立 engine、runtime thread、generation、NativeHost、输出 sequence 和 Inspector socket。

Service 负责 ADB 设备发现、安装、command-v2 传输、forward/reverse、日志消费和恢复。设备侧不开放 TCP 控制端口；完整命令保存在应用私有目录，exported 兼容入口只接收随机 command ID。

当前隔离模式是 `runtime`，即同一 Android 应用进程内的逻辑 V8 隔离。`isolatedProcess` 会稳定返回 unsupported。

网络 Provider 独立执行 authority、DNS 地址准入、socket/TLS、配额、取消和流式 credit。Fetch、redirect、Request、Response 与 Abort 语义仍由共享 JavaScript Runtime 负责。

Android 支持由 Host 在启动前提供 `holo-plugins:///` Bundle。Javet 使用 Host 生成的只读静态 plugin manifest，在 Guest entry 前完成 Cordis 安装；当前不支持运行中插件图替换或 `--watch`。

实验 v86 轨道必须在独立 instrumentation 进程中运行：它需要在创建首个 V8 isolate 前设置进程级
Liftoff-only flags。模拟器已在单个 trusted Backend 实例内运行 v86/Linux/supervisor，贯通生产
Capability Host 的归因文件读写，并让第二个 Linux 进程经 `process.network.connect` 授权后访问精确
允许的 HTTP endpoint。该实现仍未装入默认 Backend Registry，且不代表任意 TCP/UDP/DNS 已完成，因此
不能写成 Android Process Backend 已生产支持。

模拟器与物理设备使用同一产品路径，但验收报告必须分别标记；模拟器通过不能写成物理设备通过。

更多信息：[Session Host](../../../../adapters/android/session-host/README.zh-Hans.md) · [Network Provider](../../../../adapters/android/network-host/README.zh-Hans.md)
