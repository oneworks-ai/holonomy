# Android Runtime SDK (source development)

[简体中文](README.zh-Hans.md)

This library packages the production JavaScript bootstrap and the shared Holonomy Runtime for an ordinary Android Host app. It requires Android API 29+, JDK 17, Android SDK 35, NDK 27.2.12479018 / CMake 3.22.1 for `v8-host`, and Javet `5.0.10`. Supported native ABIs are `arm64-v8a` and `x86_64`; select matching APK ABI filters. Maven publication and a standalone prebuilt dependency bundle are outside this source SDK.

From the repository root, install dependencies and run `pnpm build`. The Android Gradle workspace already includes `:runtime-host`. In your application module add `implementation(project(":runtime-host"))`. Keep the existing `:host-core` and `:v8-host` projects configured. The library's `prepareRuntimeAssets` task packages a verified `runtime/asset-manifest.json`, reviewed bootstrap graph, shared Runtime outputs and module aliases into the AAR. The final app consumes the AAR and its Gradle dependencies; copying the AAR alone does not include Javet or the native engine dependency. Do not also depend on the E2E app's assets: both define `runtime/bootstrap.mjs`.

The app supplies its own exact guest module resolver and owns the engine lifecycle. A minimal `Application` or Activity can use this recipe (perform blocking waits off the UI thread):

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
    // Optional: cryptoHostFactory = { AndroidRuntimeCryptoHost() },
)
try {
    engine.start().get() // Waits for atomic synthetic-module/global installation.
    engine.executeModule(RuntimeModuleSource(entryUrl, entrySource)).get()
} finally {
    engine.dispose().get()
}
```

To enable Crypto, depend on `project(":crypto-host")`, import `ai.oneworks.holonomy.crypto.AndroidRuntimeCryptoHost`, and pass a fresh `cryptoHostFactory` for each generation. Omit it to leave Crypto unavailable. For visible output, supply a `RuntimeProcessHost`; the default is silent. For imports, expand the resolver with an explicit trusted source map; it must return `null` for unknown modules and preserve absolute resource identity. The engine continues to reserve `holonomy:///runtime/*` for digest-verified Host assets and resolves `node:*` through the composer's synthetic registry. No guest source role or import policy is relaxed.

Network defaults to no authority and no provider. This library declares no `INTERNET` permission. An app that explicitly supplies the reviewed `network-host` provider, native capabilities and bounded network authority must also declare `android.permission.INTERNET`. Supplying that permission alone grants no Runtime network capability. Optional capability/plugin services require their Host factories and reviewed configuration; this minimal recipe does not provide filesystem, storage or process access. No Linux image, backend probe, fixture runner, or diagnostic exercise control is bundled.

The asset generator can also run directly:

```sh
node adapters/android/runtime-host/tools/prepare-runtime-assets.mjs \
  "$PWD/dist" "$PWD/src" \
  "$PWD/adapters/android/runtime-host/src/runtimeBootstrap" \
  "$PWD/node_modules/acorn/dist/acorn.mjs" /tmp/holonomy-runtime-assets
```

Use an exclusively owned output directory: generation replaces its contents. Asset/digest and JavaScript owner checks prove packaging/composition boundaries; real Android engine/device acceptance is a separate gate.

Run the production owner checks with `NODE_OPTIONS=--experimental-vm-modules pnpm exec vitest run --config adapters/android/runtime-host/vitest.config.mjs`, and build the AAR with `cd adapters/android && ./gradlew :runtime-host:assembleDebug`. The network rules control driver remains part of the private Engine ABI and is removed before Guest entry.
