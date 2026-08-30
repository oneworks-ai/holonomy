# Node 兼容模块

[English](../en/capabilities/node-compatibility.md)

Holonomy 提供受限、冻结且不依赖 ambient Node global 的兼容模块。它不是完整 Node.js。

| 模块                   | 状态 | 主要范围                                         |
| ---------------------- | ---- | ------------------------------------------------ |
| `node:buffer`          | 🟡   | 创建、UTF-8/base64/base64url/hex、切片、比较     |
| `node:events`          | 🟡   | 常用 EventEmitter 注册、移除、触发与 error event |
| `node:path`            | 🟡   | POSIX 路径；无 `path.win32`                      |
| `node:url`             | 🟡   | `URL`、`URLSearchParams`；有限 file URL 转换     |
| `node:os`              | 🟡   | 启动时冻结的受限平台快照                         |
| `node:process`         | 🟡   | argv/env/cwd/platform/stdio；无任意进程控制      |
| `node:stream`          | 🟡   | 内存 Readable/Writable/Duplex/Transform/Pipeline |
| `node:stream/promises` | 🟡   | `pipeline`、`finished` 子集                      |
| `node:stream/web`      | 🟡   | 默认 WHATWG stream constructors                  |
| `node:console`         | 🟡   | 有界 Console API                                 |
| `node:timers`          | ✅   | timeout/interval                                 |
| `node:test`            | 🟡   | 顺序 runner、before/after/beforeEach/afterEach   |
| `node:assert/strict`   | 🟡   | conformance 使用的严格断言子集                   |

Guest 不获得宿主 `require`、真实宿主 `process`、真实宿主 `Buffer` 或系统 `fetch`。所有模块来自 Runtime 的 synthetic registry。

权威细粒度矩阵位于源码 `packages/runtime/src/node-compat/capabilities.ts` 与 `packages/runtime/src/streams/capabilities.ts`；本页只维护用户需要的稳定摘要。
