# 平台

[English](../en/platforms/index.md)

- [Node/Desktop](./node/index.md)：独立 Node 子进程、受限 VM、Node Inspector 与精确授权网络。
- [独立 Native holo](./native/index.md)：Rust 内嵌 V8，运行时无需 Node，当前验证 macOS arm64。
- [Android](./android/index.md)：foreground Supervisor、多逻辑 V8 Runtime、ADB 设备与原生 HTTP(S) Provider。

公共 JavaScript 语义由共享 Runtime 持有；平台只提供 Engine、调度和经过授权的原生能力。
