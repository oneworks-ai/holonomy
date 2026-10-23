# Android 开发 SDK 打包

[English](README.md)

用 JAVA_HOME 选择 JDK17，用 ANDROID_HOME（或 Android sdk.dir）指定已安装 SDK。工具不会自动安装 JDK/SDK、修改机器配置或启动设备。

在 macOS/Linux 使用当前 checkout、Node、JDK17、Android SDK35、NDK27.2.12479018 和 CMake3.22.1 构建。先安装 workspace 依赖。默认命令会先构建共享 JS 和八个选定的 debug AAR，再打包：

```sh
pnpm package:android --output /tmp/holonomy-android-sdk
node tools/android-sdk.mjs verify /tmp/holonomy-android-sdk
```

输出目录必须尚不存在；命令不会覆盖它。失败时保留公开输出和并发创建的用户文件，只清理本次私有 staging。构建、输入或清单校验失败时不会生成成功标记。

--skip-build 只用于当前 checkout 已构建的 AAR；manifest 会记录跳过。字节校验不证明被跳过构建的二进制与源码等价。相同 AAR/源码输入会生成相同归档，不等于可复现 Android 编译。

归档包含八个本地 AAR、双语接入指南、许可证和独立 Gradle consumer；不包含构建缓存、local.properties、测试 APK、E2E 应用或可选 Linux 镜像。Javet/Kotlin 和可选 Gson 仍须另行解析，不是 fat AAR 或 Maven 发布。

verification.json 最后发布，绑定归档/manifest 的 SHA256 和成员数量。校验器拒绝多余、缺失、重复、越界及 link 成员，也拒绝字节或哈希变化。它校验生产 bootstrap 与资源摘要，不验证运行时行为、设备验收、签名或生产发布。

解压已校验归档后，在已授权设备上运行独立 consumer：

```sh
./consumer/gradlew -p consumer :app:connectedDebugAndroidTest
```

consumer 只使用四个 core/Crypto AAR，并运行原样的共享 JS Crypto 用例。Kotlin 只装配引擎和核验 JS 终态，不表示八个可选库都已独立验收；模拟器结果不能写成真机通过。

应用接入见 [Runtime Host](../runtime-host/README.zh-Hans.md)、[Crypto](../crypto-host/README.zh-Hans.md) 与 [Storage](../storage-host/README.zh-Hans.md)。
