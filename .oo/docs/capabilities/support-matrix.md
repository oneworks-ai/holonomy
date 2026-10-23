# 支持矩阵

[English](../en/capabilities/support-matrix.md)

状态：✅ 已支持；🟡 支持明确子集；⛔ 未支持；🧪 实现存在，但当前证据不足以作完整平台声明。

## 平台与生命周期

| 能力                               | Node/Desktop           | Android 模拟器         | Android 物理设备                            |
| ---------------------------------- | ---------------------- | ---------------------- | ------------------------------------------- |
| `holonomy run` / `test`            | ✅                     | ✅                     | 🧪 同一实现路径，未用模拟器结果代替物理验收 |
| 前台等待与 `--detach`              | ✅                     | ✅                     | 🧪                                          |
| list/show/logs/stop/restart/remove | ✅                     | ✅                     | 🧪                                          |
| Inspector 与 DevTools              | ✅                     | ✅                     | 🧪                                          |
| Network Mock                       | ✅                     | ✅                     | 🧪                                          |
| Runtime Plugin 启动时装载          | ✅ 完整 Cordis App     | 🟡 静态同步 Host realm | 🧪 同一实现路径，未用模拟器替代物理验收     |
| Runtime Plugin Capability 拦截     | ✅ graph/drain         | 🟡 静态同步 graph      | 🧪 同一实现路径，未用模拟器替代物理验收     |
| Runtime Plugin `--watch`           | ✅ last-known-good     | ⛔                     | ⛔                                          |
| 多 Runtime                         | ✅ 独立 OS 子进程      | ✅ 同应用多逻辑 V8     | 🧪                                          |
| `isolatedProcess`                  | 不适用：已是独立子进程 | ⛔                     | ⛔                                          |

独立 Rust/V8 `holo` 是另外的 Native target，不等同于上表 Node Adapter。macOS arm64 的受控 Process 子集已通过真实 JS/Service/watch 和终止清理验证，但仍默认拒绝；只允许 Host 私有 profile 选择的程序、`processTree`、无网络/挂载并禁止后代 fork/再 exec。见 [Native Process 配置](../../../adapters/desktop/process-native-darwin.zh-Hans.md)。这不扩大 Android 或 Windows 的支持声明。

可选 Native v86 的[受限网络桥接](../../../adapters/desktop/process-v86-network.zh-Hans.md)为 Experimental：真实 Linux TCP/UDP、Host DNS、curl HTTP、拒绝/重定向、严格 AbortError、socket 配额与新 Runtime 隔离已有 12 个 Guest JS 用例。[一次性 Device/System 读取](../../../adapters/desktop/process-v86-capabilities.zh-Hans.md)另有 8 个用例，覆盖字段权限、隐私裁剪、逐进程来源与默认关闭领域。网络使用 Process Policy 而非 JS Fetch 权限；默认二进制、Darwin profile 与 fork/共享 VM 限制不变，不据此声明 Linux Device 事件、完整 TLS、地址族或工具兼容。

独立 Native macOS arm64 另可显式[安装 Desktop Device](../../../adapters/desktop/device.zh-Hans.md)：六项 required 接口及 display/lifecycle 订阅已有真实读取、初始 snapshot、overflow/getter resync、权限和代际测试。物理 display/lifecycle 变化未独立观测，change 采样仅另有受控来源测试；不据此宣布完整 Native M3 验收，也不扩大 Node/Android 支持。

Native Service 还可按真实平台描述允许 [Host 插件 Observer](../../../adapters/desktop/observer.zh-Hans.md) 的五类 optional 事件；Node 回调 ID 不会转成 Native 注册。已有真实 CJS/ESM、固定故障诊断、插件替换和代际用例；当前仍是 inline partial：没有可配置外部事件 sink，同步回调可无限阻塞，且共享闭包未强制隔离其对插件授权逻辑的影响。这不代表完整 M4。

独立 Native 入口可另行选择实验性[诊断 Profile](../../../adapters/desktop/observer-profiles.zh-Hans.md)：专用进程/isolate、有效期限和有界 owner-private JSONL，不移动旧 inline 闭包。真实 Guest JS、另一个 profile/Gate/FS 推进及故障/权限路径已有聚焦证据；另可[由 Service owner 安装](../../../adapters/desktop/managed-observer-profiles.zh-Hans.md)并通过逻辑 ID 选择，输出归每代私有资源。完整 Native/M4 验收仍独立。

## JavaScript Runtime

| 能力                               | 状态 | 说明                                                |
| ---------------------------------- | ---- | --------------------------------------------------- |
| ESM 模块图                         | ✅   | 绝对层级 URL、相对 import、有界模块图根             |
| Timers                             | ✅   | timeout、interval、取消、generation fencing         |
| Console                            | 🟡   | debug/log/info/warn/error；有界且脱敏的格式化       |
| Fetch                              | ✅   | 仅在 SandboxPolicy 允许时安装                       |
| Request/Response/Headers           | ✅   | JavaScript 层拥有公开语义                           |
| AbortController/AbortSignal        | ✅   | Fetch 取消与稳定终态                                |
| Web Streams                        | 🟡   | 默认 reader/writer；无 BYOB 与 transferable streams |
| Node Streams                       | 🟡   | 内存流；无 objectMode 与 encoding transform         |
| `node:test` / `node:assert/strict` | 🟡   | 顺序 runner、常用 hooks、TAP/JSON                   |

## 安全能力

| 能力                              | Node/Desktop           | Android 模拟器 | 说明                                                                                                                             |
| --------------------------------- | ---------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 默认网络拒绝                      | ✅                     | ✅             | `network=none` 时不安装 Fetch Provider                                                                                           |
| Mock-only 网络                    | ✅                     | ✅             | 未命中 fail closed，原生传输零调用                                                                                               |
| Restricted 网络                   | ✅                     | ✅             | canonical origin/scheme、私网和资源上限                                                                                          |
| 运行中规则 revision               | ✅                     | ✅             | generation 与 `If-Match` 双重保护                                                                                                |
| Capability Runtime `provider-v1`  | ✅                     | ✅             | 附录 H、D.3、System 与 Network v1 的声明范围及安全插件图已完成 M3 平台验收                                                       |
| Sandbox filesystem v1             | ✅                     | ✅             | 共享 Guest conformance 覆盖附录 H、watch overflow、quota、Abort 与 atomic；平台 restart E2E 覆盖旧 generation resource 与 TOCTOU |
| Host System Projection v1         | ✅                     | ✅             | Host 逐字段选择 real/synthetic/redacted/unavailable；默认不泄漏宿主信息                                                          |
| target-required Device Provider   | ✅ Headless            | ✅             | Node/Desktop当前发布Headless Node descriptor；Android required读数、真实change、revision/resync与fencing闭合                     |
| Network Broker continuation v1    | ✅                     | ✅             | real/mock、redirect 每跳、DNS/private-IP、Response body/clone、取消、诊断与 Rules revision                                       |
| Android 源码 Runtime SDK          | 不适用                 | 🟡             | 独立生产 bootstrap/AAR；API 29+，当前设备证据为 API 35 arm64；不是 Maven 发布或单文件 SDK                                        |
| Crypto primitive Provider         | 🟡 显式安装            | 🟡 显式安装    | Native、Android JCA 与 Node 可信 constructor 复用共享 SHA/HMAC/AES-GCM 子集；Node CLI/Service 不自动安装，不能由 session 启用    |
| 持久 Storage Provider             | 🟡 仅 Native KV/SQLite | 🟡 显式 KV     | Android 仅 default namespace 二进制 KV；Node Adapter 未安装内置 Provider；Android SQLite、凭据与物理设备不在该声明内             |
| 受控 `node:child_process` profile | 🟡                     | 🧪             | macOS Native profile 是显式 opt-in Stable；Android 可选 v86 AAR 为 Experimental                                                  |
| 实验 v86 Linux Backend            | 🧪                     | 🧪             | 升级镜像已通过 Node 生产门禁 6/6 和 Android API 35 arm64 模拟器共享 JS 13/13；Native 仅有声明的局部 E2E                          |
| v86 共享 `runtime` VM             | ❌                     | ❌             | 当前仅 `processTree` 每 root 一台 VM；网络包未具备不可转移的 PID 绑定，Host profile 不能启用共享 scope                           |
| v86 后代执行前准入                | ❌                     | ❌             | 升级镜像拒绝所有 Guest fork/clone 和 root 首次执行后的 exec；旧镜像的 Host allow/deny 证据不适用于当前安全边界                   |

`provider-v1` 只声明附录 H、D.3、System Projection 与 Network v1 已列出的范围，不等于完整 Node.js 或物理 Android 支持。调用顺序和精确边界见[安全能力内核](../concepts/capability-runtime.md)。

## 控制面

| 能力                         | 状态 |
| ---------------------------- | ---- |
| loopback Service + Token     | ✅   |
| TLS 远程 Service             | ✅   |
| OpenAPI 3.1                  | ✅   |
| SSE 与日志 cursor            | ✅   |
| 设备清单与受管 AVD           | ✅   |
| daemon 重启恢复与 lease 清理 | ✅   |
| 四个 OpenAPI 场景 Skill      | ✅   |

当前物理设备列表示实现与证据边界，不表示已知不兼容。验证分类见[Conformance](../testing/conformance.md)。
