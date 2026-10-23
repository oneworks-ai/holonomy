# Android Storage Host（二进制 KV v1）

[English](README.md)

为使用 [Runtime 源码 SDK](../runtime-host/README.zh-Hans.md) 的 Android Host 提供可选持久 KV。App 添加 `implementation(project(":storage-host"))` 与 `implementation(project(":capability-host"))`。模块不会自行安装，也不自动授予 Storage 权限。

Host 提供经过规范化的 Runtime 创建配置：sandboxed Storage Policy、选中的 `host.storage` Provider binding、允许的 key prefix 与有限配额。每个 generation 通过 `RuntimeCapabilityServicesFactory` 一起新建 `AndroidCapabilityHost` 和 `AndroidStorageNativeHost`，保持相同 principal/generation，由 Runtime factory 统一销毁。启用多个 NativeHost Provider 时应组合路由；不能把磁盘 IO 放入同步 Capability callback。

构造 `AndroidStorageHostConfiguration(rootDirectory, namespace, principal, generation, limits, operations)`。在 `Context.noBackupFilesDir` 下准备仅属 App 的 `0700` 目录，并传入 `canonicalFile`。native namespace 是 Host 私有标识；用户 JS 只能选择逻辑 namespace `default`。key 不会变成文件路径。

公开 API 使用共享 `holo:storage` KV get/set/delete/list。value 是二进制快照，list 有序且受限，不存在的 get 返回 null。磁盘 IO 前校验 Policy、所选 prefix 和配额。默认 key 最长 1024 bytes、value 1 MiB、list 1024 项、并发请求 32、持久条目 4096、快照 32 MiB。

单 worker 串行执行；namespace 竞争返回 `storage.conflict`。写入使用原子替换：commit 前取消保持旧快照，commit 后取消不会回滚。逻辑取消阻止迟到结果，不证明 worker 已物理退出。持久化也不承诺设备断电耐久性。目录必须保持 App 私有，同 UID Host 代码属于可信边界。

SQLite 和凭据操作明确 unsupported，不提供任意 SQL、SharedPreferences 回退或凭据导出。模拟器验证不代替物理 Android 验收。

根目录 `pnpm build` 后，在 `adapters/android` 执行：

```sh
./gradlew --offline --no-daemon :storage-host:testDebugUnitTest
./gradlew --no-daemon :storage-host:assembleDebug :storage-host:lintDebug
```

原生单元测试覆盖 IO 与生命周期边界；共享 `conformance/capabilities/storage-kv-v1.test.mjs` 拥有公开 API 断言，生产 bootstrap instrumentation 验证 Broker、真实 Android JSON/Javet、持久化及 generation 重建。三者不是同一层证据。
