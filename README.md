# Holonomy Runtime

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

## Android host boundary

The standalone Android project contains three modules:

- `host-core` owns the dedicated runtime-thread lifecycle, generation-bound wakeup scheduling and stable host errors.
- `v8-host` adapts that lifecycle to Javet Android 5.0.10, keeps native callbacks outside the guest global object and resolves only manifest-verified packaged assets.
- `e2e` is a UI-free instrumentation application. Its Gradle build compiles TypeScript to a task-private directory, packages only the bootstrap's transitive runtime graph with Acorn and explicit fixtures, and generates a SHA-256 manifest before testing the actual `createHolonomyRuntime` composer in Javet.

This is a bootstrap-stage host, not Direct V8. Its base runtime installs Node Core and in-memory Streams only. Android FS, Crypto, Network, inbound HTTP/WebSocket, Git, Storage, and `node:child_process` remain unsupported until real authorized Android providers are implemented and self-tested. Provenance-pinned managed-plugin, workspace, and Relay fixtures record planning or expected-unsupported boundaries; they are not full compatibility claims.

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

## License

[MIT](./LICENSE)
