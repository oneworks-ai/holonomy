<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/holonomy-icon-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="./assets/holonomy-icon-light.png">
    <img alt="Holonomy icon" src="./assets/holonomy-icon-light.png" width="220">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/oneworks-ai/holonomy/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/oneworks-ai/holonomy?style=flat-square"></a>
</p>

<p align="center">
  English | <a href="./README.zh-Hans.md">简体中文</a>
</p>

<h1 align="center">Holonomy</h1>

<p align="center"><strong>One runtime, every surface.</strong></p>

## Introduction

Holonomy is a capability-secure, platform-neutral JavaScript runtime for native hosts. It provides bounded Node-compatible modules, Web APIs, and explicit host contracts without making Android, V8, or any single engine the owner of runtime semantics. Explicit, observable capability boundaries also make it a safer foundation for Agent workloads.

## Quick Start

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

## Run JavaScript on Node and Android

The `holonomy` CLI compiles a bounded JavaScript module graph and submits it to the machine-level Holonomy Service. The Service owns local Node workers, Android devices, process generations, logs, Network Mock rules and Inspector leases. Adapters receive one generic code session and do not distinguish applications from tests.

`--target` is required. Node runs in a dedicated child process with a restricted `vm` Context; Android runs in an independently supervised logical V8 Runtime. Use `--detach` for a managed background process.

```sh
holonomy run examples/basic.mjs --target node
holonomy run examples/basic.mjs --target android --device emulator-5554
holonomy test "conformance/specs/**/*.test.mjs" --target android --device emulator-5554
holonomy run examples/basic.mjs --target node --detach
holonomy process list
```

Conformance files use `node:test` and `node:assert/strict`. Plain tests define common capability coverage; `it.holonomy.android(...)` and `describe.holonomy.android(...)` add Android-only verification without changing the common denominator. Missing common capabilities fail normally instead of becoming skips.

See the [Holonomy CLI guide](./tools/README.md), [Runtime execution and conformance](./docs/execution-and-conformance.md), and [Testing strategy](./docs/testing-strategy.md).

## Android host boundary

The Android project contains `host-core`, `v8-host`, `network-host`, `session-host`, and `e2e`. Together they own the dedicated runtime thread, Javet/V8 adaptation, authorized HTTP(S) networking, the foreground Runtime Supervisor, and instrumentation hosting. JavaScript retains guest API semantics; Android providers supply only their authorized host primitives.

The base runtime installs Node Core, in-memory Streams, bounded console output, native monotonic timers, JavaScript `node:test` / `node:assert/strict`, and the Android HTTP(S) provider used by Fetch. Android FS, Crypto, inbound HTTP/WebSocket, Git, Storage, and `node:child_process` remain unsupported until real authorized providers are implemented and self-tested.

Run the Android project with the documented JDK and SDK paths:

```sh
cd adapters/android
JAVA_HOME=/Users/yijie/Library/Java/JavaVirtualMachines/jbr-17.0.12/Contents/Home \
  ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
  ./gradlew test assembleDebug assembleDebugAndroidTest
```

Run instrumentation through the repository wrapper:

```sh
pnpm android:device-test --serial <adb-serial>
pnpm android:device-test --all-devices
pnpm android:device-test --all-devices --physical-only
```

The JSON summary labels every result as `emulator` or `physical`; emulator success is never reported as physical-device evidence.

## Managed V8 DevTools

The Service exposes each Node or Android V8 Inspector through a generation-scoped CDP lease. Runtime and Debugger commands reach the real V8 isolate, while the Network panel shows bounded Fetch diagnostics.

```sh
holonomy run examples/basic.mjs --target android --device emulator-5554 --inspect --detach
holonomy process inspect <process-id> --devtools
```

The Electron host is a view-only V8 frontend with Node integration disabled. User modules retain their original absolute URL, internal assets use `holonomy:///runtime/`, and Bridge or Provider identifiers are not exposed.

## License

[MIT](./LICENSE)
