# Holonomy 文档

[English](./en/index.md)

Holonomy 是面向原生宿主的平台中立 Node-like JavaScript Runtime。开发者通过同一套 CLI 与 Service，在隔离的本机 Node 子进程或 Android V8 Runtime 中运行、测试、管理和调试 JavaScript，并用显式能力策略控制网络与文件系统边界。

## 从这里开始

- 第一次运行代码：[Node 快速开始](./getting-started/run-on-node.md)或 [Android 快速开始](./getting-started/run-on-android.md)
- 先判断能否满足需求：[支持矩阵](./capabilities/support-matrix.md)
- 管理后台进程：[受管进程指南](./guides/manage-processes.md)
- 启动与清理 AVD：[管理 Android 模拟器](./guides/manage-emulators.md)
- 安全运行不可信代码：[配置 Sandbox](./guides/configure-sandbox.md)
- 拦截网络请求：[Network Mock](./guides/mock-network-requests.md)
- 查看 Sources 与 Network：[DevTools 调试](./guides/debug-with-devtools.md)
- 直接调用控制面：[Service](./service/index.md)与 [OpenAPI](./openapi/index.md)

## 阅读层级

1. [快速开始](./getting-started/index.md)只包含最短可运行路径。
2. [场景指南](./guides/index.md)围绕一个完整目标组织命令和清理步骤。
3. [核心概念](./concepts/index.md)解释 CLI、Service、Process 与 Generation 的关系。
4. [能力](./capabilities/index.md)给出当前支持程度和限制。
5. [平台](./platforms/index.md)说明 Node 与 Android 的公开差异。
6. [参考](./reference/index.md)提供策略、规则、状态和精确限制。

## 当前边界

Capability Runtime `provider-v1` 已在 Node/Desktop 与 Android 模拟器上开放受控 Filesystem、Device、Host System 与 Network Provider；所有宿主资源仍必须经过 SandboxPolicy、Cordis Middleware 和 Provider authority。Android 当前提供同一应用进程内的多逻辑 V8 Runtime，`isolatedProcess` 尚未实现。

完整限制见[已知限制](./capabilities/known-limitations.md)。

整体模块关系见[架构图](./concepts/architecture.md)，能力准入与调用顺序见[安全能力内核](./concepts/capability-runtime.md)。
