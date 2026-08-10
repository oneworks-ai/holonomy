# @oneworks/mobile-runtime

Platform-neutral JavaScript runtime primitives for One Works mobile hosts, plus a bounded Android M2 Javet bootstrap under `adapters/android`.

## Development

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
```

## Android M2 boundary

The standalone Android project contains three modules:

- `host-core` owns the dedicated runtime-thread lifecycle, generation-bound wakeup scheduling and stable host errors.
- `v8-host` adapts that lifecycle to Javet Android 5.0.10, keeps native callbacks outside the guest global object and resolves only manifest-verified packaged assets.
- `e2e` is a UI-free instrumentation application. Its Gradle build compiles TypeScript to a task-private directory, packages only the bootstrap's transitive runtime graph with Acorn and explicit fixtures, and generates a SHA-256 manifest before testing the actual `createMobileRuntime` composer in Javet.

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
