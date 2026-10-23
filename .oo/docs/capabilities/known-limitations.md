# 已知限制

[English](../en/capabilities/known-limitations.md)

以下能力当前明确不属于生产支持范围：

- Android `isolatedProcess`。
- 附录 H 未声明的其他 `node:fs` API，以及 `holo-fs://` 虚拟根之外的宿主路径访问。
- Guest 任意宿主路径访问。
- Android Git、SQLite Storage 和凭据 Provider；可选 Crypto 与持久 KV 已有生产模块和模拟器共享 JS 验证，但默认不安装，也未作物理设备验收。
- Node Adapter 内置 Storage Provider；Crypto 仅由可信 `NodeRuntimeSupervisor({ crypto: { enabled: true } })` 显式启用，普通 CLI/Service 启动不自动安装，session 也不能升级权限。独立 Rust/V8 和 Android 的实现不会自动启用 Node Adapter。
- Android 入站 HTTP/WebSocket Server。
- 未经 Host manifest 与 Process Policy 准入的 `child_process`、PATH lookup、任意 shell 或 ADB shell；升级 v86 镜像仅允许 Host 清单中的 root executable 首次执行，Guest 内后续 PATH lookup/exec 均拒绝。macOS `process-profile-v1` + `native.darwin-seatbelt-v1` 始终是非默认 opt-in 组合。
- 默认 Host Registry 不自动启用任何 Experimental Process Backend。Node/Desktop v86 只由 owner-private 安装清单启用；Android v86 只由可选生产 AAR、Host profile 与显式资产开关启用。两者都不在核心包默认携带 Linux 资产；agentOS/WASIX 尚未注册。
- Native Darwin 当前只能在 root `child_process` 调用前进入 Cordis，并由 Seatbelt 对后代进程施加静态约束；尚不能在每个后代 `exec` 前单独询问 Host。此前 v86 镜像曾实验性测试后代执行前 Host 准入，但 seccomp `CONTINUE` 无法原子绑定 Guest 指针参数；升级镜像现拒绝 Guest 后续 `execve`/`execveat` 及 fork/clone，并只开放每 root 一台 VM 的 `processTree` scope。
- Native v86 的实验网络只声明已验的有界 TCP/UDP、Host DNS 和 HTTP 代理。HTTP CONNECT、自定义 TLS 根、Guest AF_INET6、UDP 分片及更广 TLS 接受度不在本次支持范围；详见 [Native v86 网络](../../../adapters/desktop/process-v86-network.zh-Hans.md)。
- v86 文件桥只支持一个 Host 授权并映射到 `/workspace` 的 root，不承诺其他 mount 或完整 POSIX 文件系统；当前 profile 仍是 x86-32、单核、Experimental，不用 initial-state 启动能力代替真正 VM snapshot/restore。
- Native v86 已验证 touch、ls、文件/目录同步与 Host 拒绝；在显式chmod授权的profile中已验证Git init和空仓库status。此切片不代表clone/push、hooks、全部checkout或完整Git/POSIX兼容。Native access与path chmod对无法安全取得描述符的mode000对象保守拒绝，不以裸路径回退。
- Android Runtime Plugin 动态 replacement / `--watch`；Android 当前只支持启动时静态 Bundle。
- 完整 Node.js API 与所有 Node timing 边缘行为；`provider-v1` 只承诺支持矩阵列出的能力。
- 受控 ChildProcess/pipe 提供字符串事件的 `on`/`addListener`、`once`、`off`/`removeListener`、`removeAllListeners`、`listenerCount`、`listeners` 和 `eventNames`，仍不是完整 Node EventEmitter。Symbol、公开 emit、prepend、rawListeners 和 max-listener 配置不支持；移除本地回调不等于物理取消 Host 订阅，后者仍由资源关闭回收。
- Runtime 默认 `AbortSignal.timeout()` 接受 0 到 4294967295 的整数毫秒；0 也在后续 Event Loop 任务触发，单独的超时不会让 Runtime 保持运行。超时理由是 `name` 为 `TimeoutError` 的 `Error`，不是完整的 DOM `DOMException`。超过 Event Loop 单次定时上限的延时会分段等待，不采用 Node 定时器溢出的短延时行为。
- Runtime 默认 `AbortSignal.any()` 只接受同一 Runtime 构造器创建的真实 Signal，按输入顺序选取已取消理由，并在首个取消后移除其他上游监听器。跨 Runtime 或跨 realm 的 Signal 混用不属于该实现的兼容范围；显式注入的宿主原生 Abort 构造器仍遵循宿主语义。
- Native 的活跃 `fetch()` 响应体在响应头返回后被 AbortSignal 中断时，读取会拒绝为原 `signal.reason`；默认理由是名为 `AbortError` 的 `Error`，不是完整 DOM `DOMException`。响应头返回前或预先取消的请求仍使用 `network.cancelled`；原生传输 EOS 后尚未消费的缓冲克隆不跟随更晚的 Signal。显式 reader 取消、Runtime 销毁和 Provider 错误不改成用户取消理由，尚不声明完整 Fetch 兼容。
- Web Streams BYOB、transferable streams 和完整 Node objectMode streams。
- WebSocket 客户端生产传输。
- 裸公网 CDP 或未鉴权的 OpenAPI。
- Native 旧 inline Observer 闭包的强制隔离；它们仍与 Host 插件共享状态并可能无限阻塞。显式独立诊断 Profile 的 helper/有界私有输出可用于 standalone 和 owner-private Service 安装，仍为实验能力；公开远程事件导出、完整审计历史和瞬时 RSS 硬保证尚未提供。
- 执行 JavaScript、正则、模板、文件或 shell 的 Network Mock。
- 用 Android 模拟器结果声明物理设备验收。

源码中存在 facade、类型、能力矩阵或测试 Provider，不代表平台 Adapter 已经安装相应生产 Provider。Schema 接受但返回稳定 unsupported 的值也仍属于未支持。
