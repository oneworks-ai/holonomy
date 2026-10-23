# Android Crypto Host

[English](README.md)

为 [Android Runtime SDK](../runtime-host/README.zh-Hans.md) 提供可选同步 JCA primitive Provider。它支撑共享 Node/Web Crypto 子集，不建立另一套 JavaScript facade，也不是 Android Keystore 或凭据存储。

App 添加 `implementation(project(":crypto-host"))`，导入 `ai.oneworks.holonomy.crypto.AndroidRuntimeCryptoHost`，在 `RuntimeEngineFactory.create` 传入 `cryptoHostFactory = { AndroidRuntimeCryptoHost() }`。每个 generation 必须在所属 Runtime 线程创建新实例，由 engine 负责销毁；省略 factory 时 Crypto 不可用。

支持 SHA-1/SHA-256、HMAC-SHA-256、AES-256-GCM、系统随机数和定时安全比较。GCM 解密认证通过前不交付明文；IV 唯一性由调用方负责。key/明文清零为尽力实现，不能保证抹除 JCA 内部的不透明状态。

Runtime wrapper 默认 16 个 context、每 context 8 MiB、累计计账输入 16 MiB。可传入 `CryptoLimits`，但不能超过共享硬上限。这是计账/准入限制，不是进程 RSS 硬上限；不会授予原生 IO、网络权限或持久 key 存储。

在 `adapters/android` 执行 `./gradlew --offline --no-daemon :crypto-host:testDebugUnitTest :crypto-host:assembleDebug`。共享 `conformance/capabilities/crypto-v1.test.mjs` 拥有公开断言，独立生产 AAR consumer 和 API 35 arm64 模拟器通过 Javet 执行相同用例；不代表物理设备或完整 Node/Web Crypto 验收。
