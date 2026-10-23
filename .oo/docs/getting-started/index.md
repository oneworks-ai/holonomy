# 快速开始

[English](../en/getting-started/index.md)

选择一个目标完成第一次执行：

- [在 Node 上运行](./run-on-node.md)：不需要 Android SDK，每个 Runtime 使用独立子进程和受限 `vm` Context。
- [直接运行独立 holo](../platforms/native/index.md)：在 macOS arm64 上使用 Rust 内嵌 V8 的二进制，运行时无需 Node。
- [在 Android 上运行](./run-on-android.md)：需要一个已连接且在线的模拟器或物理设备。

Node 与 Android 路径通过机器级 Holonomy Service；独立 Native `holo` 当前直接管理单次执行，复用共享 Runtime、模块规划与 SandboxPolicy。

完成第一次运行后，继续阅读[管理进程](../guides/manage-processes.md)和[配置 Sandbox](../guides/configure-sandbox.md)。
