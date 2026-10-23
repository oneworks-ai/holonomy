# First development delivery

[简体中文](../../getting-started/development-release.md)

The current development delivery is `1.0.0-rc.3`, intended for local development, embedding and evaluation. It is not a complete Node.js replacement or a signed general-platform production release.

| Delivery              | Scope                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Standalone `holo`     | macOS arm64, Rust-embedded V8; running application JS requires no installed Node.js                                   |
| Android source SDK    | Production bootstrap and Android libraries; API 29+, with device evidence on an API 35 arm64 emulator                 |
| Optional capabilities | Explicitly configured filesystem, network, System/Device; Native Crypto/Storage and Android optional Crypto/binary KV |
| Disabled by default   | Process/Linux VM, ungranted filesystem/network access and uninstalled Providers                                       |

## Run on a computer

Build from source:

```sh
pnpm install
pnpm build:native
./target/release/holo ./index.js
```

Node.js/pnpm are build tools, not the delivered binary's application engine. External npm dependencies must still accompany the application and satisfy the current bounded module-loading contract. See [standalone Native](../platforms/native/index.md).

Create a local development archive:

```sh
pnpm package:native --output /absolute/path/to/a-new-output-directory
```

The output directory must not already exist. Only the final `verification.json` with status `passed` marks a completed packaging attempt, including relocated execution with an empty `PATH` and Engine Gate checks. Keep the archive SHA-256, manifest and provenance. They do not establish complete redistribution clearance, signing or notarization.

## Embed in Android

Use the production AAR/source entry in the [Runtime SDK](../../../../adapters/android/runtime-host/README.md), not the E2E APK. The app supplies its exact module resolver, output handling and engine lifecycle. Select capabilities and Policy before startup, and create fresh Host Providers for each generation.

Optional [Crypto](../../../../adapters/android/crypto-host/README.md) and [Storage KV](../../../../adapters/android/storage-host/README.md) reuse shared JS APIs. Android KV does not provide SQLite or credentials. One copied AAR does not contain Javet and every transitive dependency; the source SDK guide lists build and dependency requirements.

## Boundaries

v86 remains a separate explicitly enabled Experimental track, absent from default `holo` archives and the core Android SDK. Windows, other engines, complete Node/Web APIs, physical Android acceptance, Maven publication, signing/notarization and complete redistribution clearance are outside this development-delivery claim. See the [support matrix](../capabilities/support-matrix.md) and [known limitations](../capabilities/known-limitations.md).

Shared JS, native platform units, instrumentation and real CLI E2E verify distinct boundaries. A successful build or emulator run does not replace the other acceptance layers. See [Conformance](../testing/conformance.md).
