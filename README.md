# Holonomy Runtime

[简体中文](./README.zh-Hans.md)

`@oneworks/holonomy` is a capability-secure, platform-neutral JavaScript runtime for native hosts. It provides bounded Node-compatible modules, Web APIs and explicit host contracts without making Android, V8 or any single engine the owner of runtime semantics.

## Why Holonomy?

In geometry, holonomy describes how an object is transformed when transported around a closed path. A Möbius strip makes that idea visible: a local frame can return to its starting point with a different orientation while remaining on one continuous surface.

Holonomy applies the same idea to JavaScript. Applications move across Android and future native hosts while one reviewed runtime contract preserves scheduling, capability, resource-identity and lifecycle semantics.

> One runtime, every surface.

## Development

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
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

See the [Holonomy CLI guide](./tools/README.md) for help and machine-documentation discovery, [Runtime execution and conformance](./docs/execution-and-conformance.md) for the launch protocol and file layout, and [Testing strategy](./docs/testing-strategy.md) for case ownership and anti-duplication rules.

## Android host boundary

The standalone Android project contains five modules:

- `host-core` owns the dedicated runtime-thread lifecycle, generation-bound monotonic timer/wakeup scheduling and stable host errors.
- `v8-host` adapts that lifecycle to Javet Android 5.0.10, keeps native callbacks outside the guest global object, reserves `holonomy:///runtime/*` for manifest-verified packaged assets, and executes host-resolved guest modules without rewriting their URL scheme.
- `network-host` implements the authorized `host.network` HTTP(S) provider with cancellable DNS, address-pinned HTTP/1.1 sockets, platform TLS verification, credited response-body streaming and cancellation. Each exchange uses `Connection: close`; JavaScript continues to own `fetch`, redirects and Web response semantics.
- `session-host` owns the non-UI foreground Supervisor, multiple logical Runtime generations, bounded output, command replay and the app-private command/control protocol. `isolatedProcess` is admitted by schema but returns stable unsupported in v1.
- `e2e` is a headless development and instrumentation application. Its only exported compatibility Activity accepts a random command id and forwards to the non-exported Supervisor; test registration, execution and reporting remain JavaScript.

This is a bootstrap-stage host, not Direct V8. Its base runtime installs Node Core, in-memory Streams, bounded console output, native monotonic timers, JavaScript `node:test` / `node:assert/strict`, and the Android HTTP(S) provider used by Fetch. Android FS, Crypto, inbound HTTP/WebSocket, Git, Storage, and `node:child_process` remain unsupported until real authorized Android providers are implemented and self-tested. Provenance-pinned managed-plugin, workspace, and Relay fixtures record planning or expected-unsupported boundaries; they are not full compatibility claims.

With the documented JDK and SDK paths:

```sh
cd adapters/android
JAVA_HOME=/Users/yijie/Library/Java/JavaVirtualMachines/jbr-17.0.12/Contents/Home \
  ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
  ./gradlew test assembleDebug assembleDebugAndroidTest
```

Run instrumentation only on an already-running authorized device:

```sh
JAVA_HOME=/Users/yijie/Library/Java/JavaVirtualMachines/jbr-17.0.12/Contents/Home \
  ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
  ./gradlew :e2e:connectedDebugAndroidTest
```

The device suite includes a real V8 ESM evaluation whose entry uses a custom `fixture+device:` URL, imports a relative guest module and imports `node:path` through a V8 synthetic module. Run it through the repository wrapper on one device or sequentially across every connected emulator and physical device:

```sh
pnpm android:device-test --serial <adb-serial>
pnpm android:device-test --all-devices
pnpm android:device-test --all-devices --physical-only
```

The JSON summary labels every result as `emulator` or `physical`; emulator success is never reported as physical-device evidence.

## Managed V8 DevTools

The Service exposes each Node or Android V8 Inspector through a generation-scoped CDP lease. Runtime and Debugger commands reach the real V8 isolate; Holonomy supplies the CDP Network domain from its Fetch diagnostics, including bounded `Network.getResponseBody` support.

```sh
holonomy run examples/basic.mjs --target android --device emulator-5554 --inspect --detach
holonomy process inspect <process-id> --devtools
```

The former Android command remains a compatibility wrapper and now requires a managed process instead of constructing its own ADB session:

```sh
pnpm android:devtools status
pnpm android:devtools electron --process <process-id>
pnpm android:devtools logs --process <process-id>
pnpm android:devtools stop --process <process-id>
```

The Electron host uses Chromium's V8-only `js_app` frontend with Node integration disabled. User modules retain their original absolute URL, internal assets use `holonomy:///runtime/`, and the Network panel shows both real and mocked Fetch requests without exposing Bridge or Provider identifiers.

## License

[MIT](./LICENSE)
