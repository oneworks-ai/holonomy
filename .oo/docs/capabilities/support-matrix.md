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

| 能力                              | Node/Desktop | Android 模拟器 | 说明                                                                                                                             |
| --------------------------------- | ------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 默认网络拒绝                      | ✅           | ✅             | `network=none` 时不安装 Fetch Provider                                                                                           |
| Mock-only 网络                    | ✅           | ✅             | 未命中 fail closed，原生传输零调用                                                                                               |
| Restricted 网络                   | ✅           | ✅             | canonical origin/scheme、私网和资源上限                                                                                          |
| 运行中规则 revision               | ✅           | ✅             | generation 与 `If-Match` 双重保护                                                                                                |
| Capability Runtime `provider-v1`  | ✅           | ✅             | 附录 H、D.3、System 与 Network v1 的声明范围及安全插件图已完成 M3 平台验收                                                       |
| Sandbox filesystem v1             | ✅           | ✅             | 共享 Guest conformance 覆盖附录 H、watch overflow、quota、Abort 与 atomic；平台 restart E2E 覆盖旧 generation resource 与 TOCTOU |
| Host System Projection v1         | ✅           | ✅             | Host 逐字段选择 real/synthetic/redacted/unavailable；默认不泄漏宿主信息                                                          |
| target-required Device Provider   | ✅ Headless  | ✅             | Node/Desktop当前发布Headless Node descriptor；Android required读数、真实change、revision/resync与fencing闭合                     |
| Network Broker continuation v1    | ✅           | ✅             | real/mock、redirect 每跳、DNS/private-IP、Response body/clone、取消、诊断与 Rules revision                                       |
| 受控 `node:child_process` profile | 🟡           | 🧪             | macOS Native profile 是显式 opt-in Stable；Android 可选 v86 AAR 为 Experimental                                                  |
| 实验 v86 Linux Backend            | 🧪           | 🧪             | 两端生产模块均有 Runtime E2E：`/workspace` FUSE、TCP/UDP/DNS、Device/System、stdio、restart；Android 证据仅来自模拟器            |
| v86 后代执行前准入                | 🧪           | 🧪             | 两端均验证内核暂停、Host allow/deny、PATH-resolved target 与未知/相对路径拒绝；受限 `execveat` 同样进入 gate                     |

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
