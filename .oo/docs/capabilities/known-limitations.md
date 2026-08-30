# 已知限制

[English](../en/capabilities/known-limitations.md)

以下能力当前明确不属于生产支持范围：

- Android `isolatedProcess`。
- 附录 H 未声明的其他 `node:fs` API，以及 `holo-fs://` 虚拟根之外的宿主路径访问。
- Guest 任意宿主路径访问。
- Android Crypto、Git、Storage Provider。
- Android 入站 HTTP/WebSocket Server。
- 未经 Host manifest 与 Process Policy 准入的 `child_process`、PATH lookup、任意 shell 或 ADB shell；已准入 v86 profile 只允许 PATH 解析到 executable allowlist 中的绝对目标。macOS `process-profile-v1` + `native.darwin-seatbelt-v1` 始终是非默认 opt-in 组合。
- 默认 Host Registry 不自动启用任何 Experimental Process Backend。Node/Desktop v86 只由 owner-private 安装清单启用；Android v86 只由可选生产 AAR、Host profile 与显式资产开关启用。两者都不在核心包默认携带 Linux 资产；agentOS/WASIX 尚未注册。
- Native Darwin 当前只能在 root `child_process` 调用前进入 Cordis，并由 Seatbelt 对后代进程施加静态约束；尚不能在每个后代 `exec` 前单独询问 Host。Node/Desktop 与 Android 模拟器 v86 已实验性贯通 Linux 内核级 `execve`、受限 `execveat` 和 PATH-resolved 准入；relative dirfd、`AT_EMPTY_PATH`、相对 executable 与未知目标固定拒绝。
- v86 文件桥只支持一个 Host 授权并映射到 `/workspace` 的 root，不承诺其他 mount 或完整 POSIX 文件系统；当前 profile 仍是 x86-32、单核、Experimental，不用 initial-state 启动能力代替真正 VM snapshot/restore。
- Android Runtime Plugin 动态 replacement / `--watch`；Android 当前只支持启动时静态 Bundle。
- 完整 Node.js API 与所有 Node timing 边缘行为；`provider-v1` 只承诺支持矩阵列出的能力。
- Web Streams BYOB、transferable streams 和完整 Node objectMode streams。
- WebSocket 客户端生产传输。
- 裸公网 CDP 或未鉴权的 OpenAPI。
- 执行 JavaScript、正则、模板、文件或 shell 的 Network Mock。
- 用 Android 模拟器结果声明物理设备验收。

源码中存在 facade、类型、能力矩阵或测试 Provider，不代表平台 Adapter 已经安装相应生产 Provider。Schema 接受但返回稳定 unsupported 的值也仍属于未支持。
