# Holonomy Runtime

[English](./README.md)

`@oneworks/holonomy` 是面向原生宿主的、能力安全且平台中立的 JavaScript Runtime。它提供有边界的 Node 兼容模块、Web API 和明确的宿主契约，同时不让 Android、V8 或某个具体引擎成为运行时语义的所有者。

## 为什么叫 Holonomy？

在几何学中，Holonomy（和乐）描述对象沿闭合路径移动后发生的变换。莫比乌斯带让这个概念变得可见：局部坐标系回到起点时可能改变方向，但始终位于同一个连续曲面上。

Holonomy 把这个想法应用到 JavaScript：应用可以在 Android 和未来的原生宿主之间移动，而经过审阅的统一运行时契约保持调度、能力、资源身份和生命周期语义。

> One runtime, every surface.

## 开发

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
```

## 在 Node 与 Android 上运行 JavaScript

`holonomy` CLI 编译有边界的 JavaScript 模块图，并提交给机器级 Holonomy Service。Service 统一拥有本机 Node worker、Android 设备、进程 generation、日志、Network Mock Rules 与 Inspector Lease。Adapter 只接收通用代码会话，不区分应用代码和测试代码。

`--target` 必填。Node 使用独立子进程中的受限 `vm` Context；Android 使用 Supervisor 管理的独立逻辑 V8 Runtime。使用 `--detach` 可以得到后台受管进程。

```sh
holonomy run examples/basic.mjs --target node
holonomy run examples/basic.mjs --target android --device emulator-5554
holonomy test "conformance/specs/**/*.test.mjs" --target android --device emulator-5554
holonomy run examples/basic.mjs --target node --detach
holonomy process list
```

Conformance 文件使用 `node:test` 与 `node:assert/strict`。普通测试组成通用能力覆盖率；`it.holonomy.android(...)` 和 `describe.holonomy.android(...)` 只增加 Android 验证，不进入通用分母。缺失的通用能力会正常失败，不会被转成 skip。

CLI 帮助与机器文档发现方式见 [Holonomy CLI 指南](./tools/README.zh-Hans.md)；启动协议和文件组织见 [Runtime execution and conformance](./docs/execution-and-conformance.md)；测试层级、用例归属和避免重复建设的规则见[测试策略](./docs/testing-strategy.zh-Hans.md)。

## Android 宿主边界

独立 Android 工程包含五个模块：

- `host-core`：专用运行时线程、generation 绑定的单调时钟 Timer/唤醒调度和稳定宿主错误。
- `v8-host`：基于 Javet Android 5.0.10 适配 V8 生命周期、V8 Inspector 和模块执行；`holonomy:///runtime/*` 只属于清单校验后的内部资产，用户模块保留宿主 resolver 返回的 URL scheme。
- `network-host`：用可取消 DNS、地址绑定的 HTTP/1.1 socket、平台 TLS 校验、credit 驱动的响应流和取消机制实现授权后的 `host.network` HTTP(S) provider。每个 exchange 使用 `Connection: close`；`fetch`、重定向和 Web Response 语义仍由 JavaScript 负责。
- `session-host`：非 UI foreground Supervisor、多逻辑 Runtime generation、有界输出、命令重放与 app-private control protocol。`isolatedProcess` 首版由 schema 接收，但稳定返回 unsupported。
- `e2e`：无界面的调试宿主和 instrumentation 应用；唯一 exported 兼容 Activity 只接收随机 command ID 并转发给 non-exported Supervisor，测试注册、执行和报告仍全部位于 JavaScript。

当前基础运行时已经安装 Node Core、内存 Streams、有界 console 输出、原生单调时钟 timers、JavaScript `node:test` / `node:assert/strict`，以及供 Fetch 使用的 Android HTTP(S) provider。Android FS、Crypto、入站 HTTP/WebSocket、Git、Storage 和 `node:child_process` 仍需各自真实且经过授权的 Android provider。

设备 instrumentation 包含一段真正由 V8 执行的 ESM：入口使用自定义 `fixture+device:` URL，同时导入相对用户模块和通过 V8 synthetic module 提供的 `node:path`。可以指定单台设备，或顺序批量执行所有已连接模拟器与真机：

```sh
pnpm android:device-test --serial <adb-serial>
pnpm android:device-test --all-devices
pnpm android:device-test --all-devices --physical-only
```

JSON 报告会把每台设备明确标成 `emulator` 或 `physical`，不会把模拟器通过冒充成真机证据。

## 受管 V8 DevTools

Service 为每个 Node 或 Android V8 Inspector 提供 generation 绑定的 CDP Lease。Runtime 与 Debugger 命令会进入真实 V8 isolate；CDP Network domain 来自 Holonomy Fetch diagnostics，并提供有边界的 `Network.getResponseBody`。

```sh
holonomy run examples/basic.mjs --target android --device emulator-5554 --inspect --detach
holonomy process inspect <process-id> --devtools
```

旧 Android 命令保留为兼容 wrapper，但现在必须操作受管进程，不再自行构造 ADB session：

```sh
pnpm android:devtools status
pnpm android:devtools electron --process <process-id>
pnpm android:devtools logs --process <process-id>
pnpm android:devtools stop --process <process-id>
```

Electron 宿主使用 Chromium V8-only `js_app` 前端，并关闭 Node integration。用户模块保留原始绝对 URL，内部资产使用 `holonomy:///runtime/`；Network 面板同时显示真实与 Mock Fetch，且不会暴露 Bridge 或 Provider 内部 ID。

## 协议

[MIT](./LICENSE)
