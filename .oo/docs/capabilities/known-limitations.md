# 已知限制

[English](../en/capabilities/known-limitations.md)

以下能力当前明确不属于生产支持范围：

- Android `isolatedProcess`。
- Node 或 Android 的生产 sandbox 文件系统 Provider。
- Guest 任意宿主路径访问。
- Android Crypto、Git、Storage Provider。
- Android 入站 HTTP/WebSocket Server。
- Guest 任意 `child_process`、shell 或 ADB shell。
- 完整 Node.js API 与所有 Node timing 边缘行为。
- Web Streams BYOB、transferable streams 和完整 Node objectMode streams。
- WebSocket 客户端生产传输。
- 裸公网 CDP 或未鉴权的 OpenAPI。
- 执行 JavaScript、正则、模板、文件或 shell 的 Network Mock。
- 用 Android 模拟器结果声明物理设备验收。

源码中存在 facade、类型、能力矩阵或测试 Provider，不代表平台 Adapter 已经安装相应生产 Provider。Schema 接受但返回稳定 unsupported 的值也仍属于未支持。
