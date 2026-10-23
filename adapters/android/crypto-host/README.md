# Android Crypto Host

[简体中文](README.zh-Hans.md)

An optional synchronous JCA primitive Provider for the [Android Runtime SDK](../runtime-host/README.md). It implements the native primitives used by the shared Node/Web Crypto subset, not a separate JavaScript facade, Android Keystore or credential store.

Add `implementation(project(":crypto-host"))` to the App and import `ai.oneworks.holonomy.crypto.AndroidRuntimeCryptoHost`. Pass `cryptoHostFactory = { AndroidRuntimeCryptoHost() }` to `RuntimeEngineFactory.create`. The factory must create a fresh instance on the owning Runtime thread for every generation; the engine owns its disposal. Omit the factory to leave Crypto unavailable.

Supported primitives: SHA-1/SHA-256, HMAC-SHA-256, AES-256-GCM, OS random bytes and timing-safe comparison. GCM decryption releases no plaintext before authentication succeeds. IV uniqueness remains the caller's responsibility. Key/plaintext wiping is best effort and cannot guarantee erasure of opaque JCA state.

The Runtime wrapper defaults to 16 contexts, 8 MiB per context and 16 MiB aggregate accounted input. A `CryptoLimits` argument may change limits within the shared hard ceilings. These are accounting/admission bounds, not a hard process-RSS limit. There is no native I/O, network permission or persistent key storage grant.

From `adapters/android`, run `./gradlew --offline --no-daemon :crypto-host:testDebugUnitTest :crypto-host:assembleDebug`. Public behavior is owned by shared `conformance/capabilities/crypto-v1.test.mjs`; production-AAR consumer and API 35 arm64 emulator tests exercise it through Javet. This is not physical-device or complete Node/Web Crypto acceptance.
