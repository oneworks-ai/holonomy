# Android Storage Host (binary KV v1)

[简体中文](README.zh-Hans.md)

Optional persistent binary KV for an Android Host using the [Runtime source SDK](../runtime-host/README.md). Add `implementation(project(":storage-host"))` and `implementation(project(":capability-host"))` to your App. This module does not install itself or grant Storage authority.

The Host supplies a normalized Runtime creation configuration with sandboxed Storage Policy, a selected `host.storage` Provider binding, allowed key prefixes and finite limits. Create a fresh `AndroidCapabilityHost` and `AndroidStorageNativeHost` together with `RuntimeCapabilityServicesFactory` for each generation. Keep the same principal/generation in both; the Runtime factory owns their disposal. Compose other NativeHost providers when enabling more than Storage. Do not route disk IO through the synchronous Capability callback.

Construct `AndroidStorageHostConfiguration(rootDirectory, namespace, principal, generation, limits, operations)`. Provision an owner-only `0700` directory below `Context.noBackupFilesDir` and pass its `canonicalFile`. The native namespace is Host-private; user JS selects only the logical `default` namespace. Keys never become filesystem paths.

The public API is shared `holo:storage` KV get/set/delete/list. Values are binary snapshots, list results are sorted and bounded, and missing get returns null. Explicit Policy and selected prefix/limit constraints are enforced before native IO. Defaults limit keys to 1024 bytes, values to 1 MiB, list results to 1024, pending operations to 32, persisted entries to 4096 and the snapshot to 32 MiB.

One worker serializes operations. Namespace contention returns `storage.conflict`. Writes use atomic replacement; cancellation before commit leaves the prior snapshot intact, but cancellation after commit does not roll it back. A logical cancellation fences result delivery; it is not proof of physical worker termination. Persistence is not a device-power-loss durability guarantee. The directory must remain app-private and same-UID Host code trusted.

SQLite and credential operations are explicitly unsupported. No arbitrary SQL, SharedPreferences fallback or credential export is provided. Physical Android acceptance remains separate from emulator verification.

Build and test from `adapters/android` after the root `pnpm build`:

```sh
./gradlew --offline --no-daemon :storage-host:testDebugUnitTest
./gradlew --no-daemon :storage-host:assembleDebug :storage-host:lintDebug
```

Native module tests cover IO and lifecycle seams. Shared `conformance/capabilities/storage-kv-v1.test.mjs` owns public API assertions; production-bootstrap instrumentation exercises the Broker, real Android JSON/Javet, persistence and generation recreation. These are distinct test layers.
