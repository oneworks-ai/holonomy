# Android development SDK bundle

[简体中文](README.zh-Hans.md)

Configure JAVA_HOME for JDK17 and ANDROID_HOME (or Android sdk.dir) for the installed SDK. The tool does not install a JDK/SDK, change machine configuration or start a device.

Build a local SDK from this checkout on macOS/Linux with Node, JDK17, Android SDK35, NDK27.2.12479018 and CMake3.22.1. Install workspace dependencies first. The normal command builds shared JS and all eight selected debug AARs before packaging:

```sh
pnpm package:android --output /tmp/holonomy-android-sdk
node tools/android-sdk.mjs verify /tmp/holonomy-android-sdk
```

The output directory must not exist. The command refuses to overwrite it. Failures retain the public output and any concurrent user file; only its new private staging tree is cleaned. If any build/input/inventory step fails, no successful completion marker is issued.

Use --skip-build only for already-built AARs from this checkout. The manifest records this choice; byte checks do not establish source-to-binary equivalence for skipped builds. Archives are deterministic for identical AAR/source bytes, not a claim of reproducible Android compilation.

The archive contains eight local AARs, bilingual integration guides, licenses and an independent Gradle consumer. It excludes build caches, local.properties, test APKs, the E2E application and optional Linux assets. Javet/Kotlin and optional Gson remain external dependencies; this is not a fat AAR or Maven publication.

verification.json is the final completion marker. It binds the archive and manifest SHA256 plus exact member counts. The verifier rejects extra/missing/duplicate/traversal/link entries and byte/hash changes. It checks the production Runtime bootstrap and asset digests, not runtime behavior or device acceptance. No signing or production-release claim is made.

Extract the verified archive and run the independent consumer with an already-authorized device:

```sh
./consumer/gradlew -p consumer :app:connectedDebugAndroidTest
```

The consumer uses four core/Crypto AARs and runs the unchanged shared JS Crypto cases. Kotlin only assembles the engine and checks the JS terminal. This is not acceptance for every optional library; emulator evidence is not physical-device acceptance.

For application embedding see [Runtime Host](../runtime-host/README.md), [Crypto](../crypto-host/README.md) and [Storage](../storage-host/README.md).
