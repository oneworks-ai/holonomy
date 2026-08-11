<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/holonomy-icon-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="./assets/holonomy-icon-light.png">
    <img alt="Holonomy 图标" src="./assets/holonomy-icon-light.png" width="220">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/oneworks-ai/holonomy/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/oneworks-ai/holonomy?style=flat-square"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | 简体中文
</p>

<h1 align="center">Holonomy</h1>

<p align="center"><strong>一个运行时，跨越每一种载体。</strong></p>

## 介绍

Holonomy 是一个面向原生宿主、能力安全且平台中立的 JavaScript 运行时。它提供边界明确的 Node 兼容模块、Web API 和宿主契约，同时不让 Android、V8 或任何单一引擎成为运行时语义的所有者。显式、可观测的能力边界也让它成为承载 Agent 工作负载的更安全基础。

## 快速开始

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

## 在 Node 与 Android 上运行 JavaScript

`holonomy` CLI 会编译有边界的 JavaScript 模块图，并提交给机器级 Holonomy Service。Service 统一管理本机 Node worker、Android 设备、进程 generation、日志、Network Mock Rules 与 Inspector Lease。Adapter 只接收通用代码会话，不区分应用代码和测试代码。

`--target` 必填。Node 使用独立子进程中的受限 `vm` Context；Android 使用 Supervisor 管理的独立逻辑 V8 Runtime。使用 `--detach` 可以得到后台受管进程。

```sh
holonomy run examples/basic.mjs --target node
holonomy run examples/basic.mjs --target android --device emulator-5554
holonomy test "conformance/specs/**/*.test.mjs" --target android --device emulator-5554
holonomy run examples/basic.mjs --target node --detach
holonomy process list
```

Conformance 文件使用 `node:test` 与 `node:assert/strict`。普通测试组成通用能力覆盖率；`it.holonomy.android(...)` 和 `describe.holonomy.android(...)` 只增加 Android 验证，不改变通用分母。缺失的通用能力会正常失败，不会被转成 skip。

参见 [Holonomy CLI 指南](./tools/README.zh-Hans.md)、[Runtime execution and conformance](./docs/execution-and-conformance.md) 与[测试策略](./docs/testing-strategy.zh-Hans.md)。

## Android 宿主边界

Android 工程包含 `host-core`、`v8-host`、`network-host`、`session-host` 和 `e2e`，分别负责专用运行时线程、Javet/V8 适配、授权 HTTP(S) 网络、前台 Runtime Supervisor 和 instrumentation 宿主。JavaScript 保留 guest API 语义；Android provider 只提供经过授权的宿主原语。

当前基础运行时已经安装 Node Core、内存 Streams、有界 console 输出、原生单调时钟 timers、JavaScript `node:test` / `node:assert/strict`，以及供 Fetch 使用的 Android HTTP(S) provider。Android FS、Crypto、入站 HTTP/WebSocket、Git、Storage 和 `node:child_process` 仍需各自真实且经过授权的 provider。

可使用文档中的 JDK 和 SDK 路径运行 Android 工程：

```sh
cd adapters/android
JAVA_HOME=/Users/yijie/Library/Java/JavaVirtualMachines/jbr-17.0.12/Contents/Home \
  ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
  ./gradlew test assembleDebug assembleDebugAndroidTest
```

通过仓库 wrapper 运行 instrumentation：

```sh
pnpm android:device-test --serial <adb-serial>
pnpm android:device-test --all-devices
pnpm android:device-test --all-devices --physical-only
```

JSON 报告会把每台设备明确标成 `emulator` 或 `physical`，不会把模拟器成功冒充成真机证据。

## 受管 V8 DevTools

Service 为每个 Node 或 Android V8 Inspector 提供 generation 绑定的 CDP Lease。Runtime 与 Debugger 命令会进入真实 V8 isolate，Network 面板显示有边界的 Fetch diagnostics。

```sh
holonomy run examples/basic.mjs --target android --device emulator-5554 --inspect --detach
holonomy process inspect <process-id> --devtools
```

Electron 宿主是关闭 Node integration 的只读 V8 前端。用户模块保留原始绝对 URL，内部资产使用 `holonomy:///runtime/`，且不会暴露 Bridge 或 Provider 内部 ID。

## 许可证

[MIT](./LICENSE)
