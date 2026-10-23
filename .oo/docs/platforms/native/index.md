# 独立 Native `holo`

[English](../../en/platforms/native/index.md)

`holo` 用 Rust 和 `rusty_v8` 内嵌 V8，直接在电脑上运行 JavaScript。当前已验证的平台是 macOS arm64，交付形式为开发版二进制。

首版开发交付保持 `1.0.0-rc.3`：macOS arm64 独立二进制与 Android 嵌入式源码 SDK。它不是全平台正式发行或完整 Node.js 替代品。默认归档不包含 Linux VM；签名、公证、完整再分发许可和物理 Android 验收仍独立进行，不因本地回归通过而视为完成。统一入口见[首个开发版](../../getting-started/development-release.md)。

## 第一次运行

源码构建需要仓库锁定的 Rust 工具链和 pnpm 依赖：

```sh
pnpm install
pnpm build:native
```

创建 `index.js`：

```js
const assert = require('node:assert/strict')
assert.equal(process.versions.node, undefined)
console.log('Hello from standalone Holonomy')
```

在该文件所在目录执行：

```sh
/path/to/holonomy/target/release/holo ./index.js
```

运行不依赖已安装的 Node、Holonomy 自身的 `node_modules` 或源码仓库。用户程序如果引用外部 npm 包，仍需随程序提供其依赖，并满足当前模块加载支持范围。Node/esbuild 仅用于源码构建。

## 常用命令

```sh
holo ./index.js argument
holo --timeout 5000 ./index.mjs
holo test ./example.test.mjs
holo --host-config ./host.json ./index.mjs
holo engine info --json
```

默认不继承宿主环境变量或授予文件/网络能力。通过 Host 配置选择 Policy、目录、系统字段与 Cordis 插件；详细用法见 [Native 模块指南](../../../../adapters/desktop/README.zh-Hans.md)和 [Host 配置](../../../../adapters/desktop/host-configuration.zh-Hans.md)。

Native 支持边界独立于 Node/Android。已支持文件与目录 watch、显式授权的 Host 请求体检查、可选[源码读取审计](../../../../adapters/desktop/managed-source-audit.zh-Hans.md)（含 Service 独立安装），以及部分 Host-only Observer 事件。另有实验性[私有 Inspector](../../../../adapters/desktop/inspector.zh-Hans.md)和[外部 Service Native target](../../../../tools/service/README.zh-Hans.md)；后者支持插件 Bundle 的初始安装、配置数组更新与应用确认，Native 执行本身不依赖 Node。[部分 Storage](../../../../adapters/desktop/storage.zh-Hans.md) 已支持显式安装的持久 KV/SQLite，并已统一到 Policy/Cordis 逐次拦截；凭据 Provider 尚未实现。实验性 Service Inspector lease 已接通入口等待/恢复与代际清理。显式选择的[独立诊断 Profile](../../../../adapters/desktop/observer-profiles.zh-Hans.md)在专用辅助进程/isolate 执行并输出有界私有 JSONL；另支持 owner-private 的 [Service Profile 安装](../../../../adapters/desktop/managed-observer-profiles.zh-Hans.md)、逻辑 ID 选择及每代私有输出；旧 inline Observer 仍为 partial。更广的 Process/网络桥接、完整 M4 与生产发布验收仍未完成；当前开发包尚未完成签名、公证和完整再分发许可闭包。
