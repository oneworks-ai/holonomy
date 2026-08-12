# Android 平台

[English](../../en/platforms/android/index.md)

Android 使用非 UI foreground Supervisor 管理多个逻辑 V8 Runtime。每个 Runtime 拥有独立 engine、runtime thread、generation、NativeHost、输出 sequence 和 Inspector socket。

Service 负责 ADB 设备发现、安装、command-v2 传输、forward/reverse、日志消费和恢复。设备侧不开放 TCP 控制端口；完整命令保存在应用私有目录，exported 兼容入口只接收随机 command ID。

当前隔离模式是 `runtime`，即同一 Android 应用进程内的逻辑 V8 隔离。`isolatedProcess` 会稳定返回 unsupported。

网络 Provider 独立执行 authority、DNS 地址准入、socket/TLS、配额、取消和流式 credit。Fetch、redirect、Request、Response 与 Abort 语义仍由共享 JavaScript Runtime 负责。

模拟器与物理设备使用同一产品路径，但验收报告必须分别标记；模拟器通过不能写成物理设备通过。

更多信息：[Session Host](../../../../adapters/android/session-host/README.zh-Hans.md) · [Network Provider](../../../../adapters/android/network-host/README.zh-Hans.md)
