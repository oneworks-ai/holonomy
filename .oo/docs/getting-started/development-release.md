# 首个开发版

[English](../en/getting-started/development-release.md)

当前开发交付版本是 `1.0.0-rc.3`，面向本地开发、嵌入与试用，不是完整 Node.js 替代品或已签名的跨平台正式发行。

| 交付             | 范围                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| 独立 `holo`      | macOS arm64，Rust 内嵌 V8；运行用户 JS 不依赖安装 Node.js                                       |
| Android 源码 SDK | 生产 bootstrap 与 Android library；API 29+，当前设备证据为 API 35 arm64 模拟器                  |
| 可选能力         | 显式 Host 配置的文件、网络、系统/Device；Native Crypto/Storage 与 Android 可选 Crypto/二进制 KV |
| 默认关闭         | Process/Linux VM、未授予的文件与网络、未安装的 Provider                                         |

## 电脑上运行

源码构建：

```sh
pnpm install
pnpm build:native
./target/release/holo ./index.js
```

Node.js/pnpm 是构建工具，不是交付二进制运行用户代码的引擎。外部 npm 依赖仍须随应用提供，并符合当前受限模块加载范围。详见 [独立 Native](../platforms/native/index.md)。

本地生成开发归档：

```sh
pnpm package:native --output /absolute/path/to/a-new-output-directory
```

输出目录必须尚不存在。仅在 `verification.json` 最后生成且状态为 `passed` 时，才表示这次归档完成；它包含空 `PATH` 下的解包运行和 Engine Gate 检查。保留归档 SHA-256、manifest 和 provenance；它们不代替完整再分发许可、签名或公证。

## 嵌入 Android App

使用 [Runtime SDK](../../../adapters/android/runtime-host/README.zh-Hans.md) 的生产 AAR/源码入口，不要引用 E2E APK。App 提供自己的精确模块 resolver、输出处理和 engine 生命周期。启动前显式选择能力与 Policy，每个 generation 创建新的 Host Provider。

可选 [Crypto](../../../adapters/android/crypto-host/README.zh-Hans.md) 与 [Storage KV](../../../adapters/android/storage-host/README.zh-Hans.md) 都复用共享 JS API。Android KV 不提供 SQLite 或凭据。单独复制一个 AAR 不含 Javet 和其他传递依赖；源码 SDK 文档列出了构建与依赖要求。

## 支持边界

v86 仍是独立、显式启用的 Experimental 路径，不随默认 `holo` 或核心 Android SDK 打包。Windows、其他引擎、完整 Node/Web API、Android 物理设备验收、Maven 发布、签名/公证及完整再分发许可仍不属于这份开发交付声明。详见 [支持矩阵](../capabilities/support-matrix.md) 和 [已知限制](../capabilities/known-limitations.md)。

共享 JS、平台 native 单元、instrumentation 和真实 CLI E2E 分别验证不同边界；不能用构建成功或模拟器结果替代其他验收。运行方式见 [Conformance](../testing/conformance.md)。
