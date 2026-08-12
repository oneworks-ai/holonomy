# 支持矩阵

[English](../en/capabilities/support-matrix.md)

状态：✅ 已支持；🟡 支持明确子集；⛔ 未支持；🧪 实现存在，但当前证据不足以作完整平台声明。

## 平台与生命周期

| 能力                               | Node/Desktop           | Android 模拟器     | Android 物理设备                            |
| ---------------------------------- | ---------------------- | ------------------ | ------------------------------------------- |
| `holonomy run` / `test`            | ✅                     | ✅                 | 🧪 同一实现路径，未用模拟器结果代替物理验收 |
| 前台等待与 `--detach`              | ✅                     | ✅                 | 🧪                                          |
| list/show/logs/stop/restart/remove | ✅                     | ✅                 | 🧪                                          |
| Inspector 与 DevTools              | ✅                     | ✅                 | 🧪                                          |
| Network Mock                       | ✅                     | ✅                 | 🧪                                          |
| 多 Runtime                         | ✅ 独立 OS 子进程      | ✅ 同应用多逻辑 V8 | 🧪                                          |
| `isolatedProcess`                  | 不适用：已是独立子进程 | ⛔                 | ⛔                                          |

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

| 能力                    | 状态 | 说明                                    |
| ----------------------- | ---- | --------------------------------------- |
| 默认网络拒绝            | ✅   | `network=none` 时不安装 Fetch Provider  |
| Mock-only 网络          | ✅   | 未命中 fail closed，原生传输零调用      |
| Restricted 网络         | ✅   | canonical origin/scheme、私网和资源上限 |
| 运行中规则 revision     | ✅   | generation 与 `If-Match` 双重保护       |
| 文件系统默认拒绝        | ✅   | 不暴露宿主路径                          |
| 生产 sandbox filesystem | ⛔   | `filesystem=sandboxed` 返回稳定 501     |

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
