# Android Crypto native primitives

Read [../AGENTS.md](../AGENTS.md). `JcaCryptoProvider` owns owner-thread native context IDs, bounded JCA primitives, authentication and disposal. `AndroidRuntimeCryptoHost` adapts the engine-only interface and supplies one immutable mobile limits object to native and shared JS installation. Do not introduce NativeBridge, Keystore, persistent keys or another Node/Web facade here.

Primitive seam tests live beside the provider. Shared JS conformance owns public semantics; `runtime-host` owns JS transport and `v8-host/AndroidCryptoEngineBinding.kt` owns no-callback ArrayBuffer copies. Never use overridable TypedArray getters/species at that boundary.
