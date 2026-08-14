# 核心概念

[English](../en/concepts/index.md)

- [整体架构](./architecture.md)：控制面、平台执行、共享 Runtime 与诊断通道如何连接。
- [安全能力内核](./capability-runtime.md)：Context、Policy、Middleware 与 Provider 如何组成不可绕过的调用链。
- [Runtime 插件与热更新](./runtime-plugins.md)：Cordis 插件、`holo-plugins:///` 资源、跨平台静态装载和 Node/Desktop CLI watch。
- [Runtime 里程碑](./milestones.md)：M2、M2.5、M3、M3.5 与 M4 的完成边界和下一步。
- [Service 与 CLI](./service-and-cli.md)：谁拥有长期资源，为什么 CLI 不直接管理 ADB。
- [Process 与 Generation](./process-and-generation.md)：稳定进程身份与可替换 Runtime 实例。

这些页面解释用户可见模型。内部线程、协议与 Provider 约束由最近的 `AGENTS.md` 维护。
