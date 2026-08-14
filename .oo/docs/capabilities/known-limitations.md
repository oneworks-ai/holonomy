# 已知限制

[English](../en/capabilities/known-limitations.md)

以下能力当前明确不属于生产支持范围：

- Android `isolatedProcess`。
- Node 或 Android 的完整生产 sandbox 文件系统 Provider；当前只开放受控 workspace `kernel-slice`。
- Guest 任意宿主路径访问。
- Android Crypto、Git、Storage Provider。
- Android 入站 HTTP/WebSocket Server。
- 未经 Host manifest 与 Process Policy 准入的 `child_process`、PATH lookup、任意 shell 或 ADB shell；macOS `process-profile-v1` + `native.darwin-seatbelt-v1` 始终是非默认 opt-in 组合。
- 默认 Host Registry 不自动启用任何 Experimental Process Backend。v86 只能由 owner-private 安装清单启用且不随包提供 Linux 资产；agentOS/WASIX 尚未注册，Android 也尚无生产 Backend。
- Android Runtime Plugin 动态 replacement / `--watch`；Android 当前只支持启动时静态 Bundle。
- 完整 Node.js API 与所有 Node timing 边缘行为。
- Web Streams BYOB、transferable streams 和完整 Node objectMode streams。
- WebSocket 客户端生产传输。
- 裸公网 CDP 或未鉴权的 OpenAPI。
- 执行 JavaScript、正则、模板、文件或 shell 的 Network Mock。
- 用 Android 模拟器结果声明物理设备验收。

源码中存在 facade、类型、能力矩阵或测试 Provider，不代表平台 Adapter 已经安装相应生产 Provider。Schema 接受但返回稳定 unsupported 的值也仍属于未支持。
