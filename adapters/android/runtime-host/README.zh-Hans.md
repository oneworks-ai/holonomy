# Android Runtime SDK（源码开发版）

[English](README.md)

本 library 为普通 Android Host App 提供生产 JavaScript bootstrap 与共享 Holonomy Runtime。最低 Android API 29，构建需要 JDK 17、Android SDK 35；`v8-host` 使用 NDK 27.2.12479018 / CMake 3.22.1 与 Javet 5.0.10。支持 `arm64-v8a`、`x86_64`，App 的 ABI filters 须匹配。本版本交付源码集成，不包含 Maven 发布。

先在仓库根目录安装依赖并执行 `pnpm build`。仓库的 Android Gradle 工程已包含 `:runtime-host`；App 添加 `implementation(project(":runtime-host"))`，保留现有 `:host-core`、`:v8-host` 项目配置。library 的 `prepareRuntimeAssets` 会将经过摘要验证的资产、模块别名与 bootstrap 图打入 AAR。App 必须通过 Gradle 同时消费依赖；单独复制 AAR 不包含 Javet/native engine。不要同时引入 E2E App 的资产，它们都定义 `runtime/bootstrap.mjs`。

Host App 自己提供 Guest 模块 resolver 并负责 engine 生命周期。可在 Application/Activity 中按以下方式嵌入；阻塞等待需放在非 UI 线程：

```kotlin
import ai.oneworks.holonomy.host.FailClosedRuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeModuleResolver
import ai.oneworks.holonomy.host.RuntimeModuleSource
import ai.oneworks.holonomy.v8.RuntimeEngineFactory

val entryUrl = "app://runtime/index.mjs"
val entrySource = "console.log('Hello from Holonomy')"
val resolver = RuntimeModuleResolver { specifier, referrer ->
    val url = if (referrer == null) specifier
        else java.net.URI(referrer).resolve(specifier).toString()
    if (url == entryUrl) RuntimeModuleSource(entryUrl, entrySource) else null
}
val engine = RuntimeEngineFactory.create(
    assets = applicationContext.assets,
    nativeHostFactory = { FailClosedRuntimeNativeHost() },
    moduleResolver = resolver,
    // 可选：cryptoHostFactory = { AndroidRuntimeCryptoHost() },
)
try {
    engine.start().get() // 等待 synthetic modules/globals 原子安装完成。
    engine.executeModule(RuntimeModuleSource(entryUrl, entrySource)).get()
} finally {
    engine.dispose().get()
}
```

若启用 Crypto，App 需依赖 `project(":crypto-host")`，导入 `ai.oneworks.holonomy.crypto.AndroidRuntimeCryptoHost`，并通过 `cryptoHostFactory` 为每个 generation 创建新实例；省略时 Crypto 不可用。可通过 `RuntimeProcessHost` 接收输出，默认实现静默。多模块 App 应使用显式 source map 扩充 resolver，未知模块返回 `null`，保持绝对资源 URL 身份。`holonomy:///runtime/*` 仍只用于摘要验证的 Host 资产，`node:*` 由共享 composer 的 synthetic registry 解析；不放宽 Guest import 或 source role。

默认没有网络 authority/provider，library 不声明 `INTERNET`。App 显式配置经过审查的 `network-host` provider、native capabilities 和受限 network authority 时，还需声明 `android.permission.INTERNET`；只有系统权限不会赋予 Runtime 网络能力。可选 capability/plugin services 需要 Host factories 与对应配置。最小 recipe 不授予文件系统、Storage 或 Process 权限。生产资产不包含 Linux 镜像、Backend probe、fixtures 或测试 exercise 控制。

独立打包命令见 [English README](README.md)。输出目录须由调用方独占，因为 generator 会替换目录内容。验证命令：

```sh
NODE_OPTIONS=--experimental-vm-modules pnpm exec vitest run \
  --config adapters/android/runtime-host/vitest.config.mjs
cd adapters/android
./gradlew :runtime-host:assembleDebug
```

资产摘要、JS owner 与 AAR 构建只证明对应边界；真实 Android 引擎和设备执行属于另一项验收门槛。
