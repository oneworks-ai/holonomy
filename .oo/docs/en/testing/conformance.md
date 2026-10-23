# Conformance usage and evidence

[简体中文](../../testing/conformance.md)

Conformance runs the same `node:test` files through the real `holonomy test` entry point. It verifies the complete developer path: CLI → Service → Adapter → shared Runtime → public JavaScript API.

```sh
pnpm holonomy test "conformance/specs/**/*.test.mjs" \
  --target node \
  --sandbox conformance/sandbox/restricted.json \
  --reporter json
```

Android uses the same files:

```sh
pnpm holonomy test "conformance/specs/**/*.test.mjs" \
  --target android \
  --device emulator-5554 \
  --sandbox conformance/sandbox/restricted.json \
  --reporter json
```

Ordinary `describe`/`it` cases define the cross-platform common denominator. A missing capability fails instead of being skipped automatically. `describe.holonomy.android` and `it.holonomy.android` declare an explicit platform-only promise, are reported separately, and do not enter the common denominator.

Android instrumentation is Adapter integration evidence, not CLI E2E. Emulator evidence is labeled `emulator`; only an actual connected physical device execution can be labeled `physical`.

Cases that require an explicit Host profile live under `conformance/capabilities/` and are not mixed into the default
deny-all suite. For example, Node/Desktop and Android use the same `process-v86.test.mjs` JavaScript contract; Android
E2E with the upgraded image has API 35 arm64 emulator evidence, not physical-device acceptance. The JavaScript case owns
`node:child_process` results, callbacks, stdio, exit and public error semantics; Android instrumentation owns only asset
packaging, startup, restart and the JavaScript runner terminal. Invoke it with the corresponding `--capability-runtime`
request while the Host has the named Process profile installed.

The default common conformance covers Console, Timers, `node:path`, `node:buffer`, module URLs, Fetch JSON, and Fetch
abort. Explicit capability conformance additionally covers controlled v86 `node:child_process`, `/workspace` FUSE,
TCP/UDP/DNS, Device/System projection, and denial of later Guest exec in the upgraded image. The previous image's
descendant pre-execution admission evidence does not carry forward.

`crypto-v1.test.mjs` and `storage-kv-v1.test.mjs` also own public JS assertions. Android instrumentation only assembles the production SDK, native Providers, private fixture directory and generations, then checks the JS runner terminal. Crypto accounting limits and logical Storage cancellation do not prove a hard process RSS bound or physical native-worker termination.

Explicit v86 verification uses separate phases: the Host defaults to a 300-second cold-start ceiling, while process execution starts after readiness. Test watchdogs account for startup, execution, transport and cleanup rather than enclosing VM creation in 90/120 seconds. The fixed suite can start 12 separate VMs, so its worst-case bound is long and is not a startup-performance SLA. Ordinary Runtime/SDK execution does not use this track. The 13-case JS terminal, natural instrumentation completion and owned VM-worker exit are distinct necessary evidence; an intermediate log or cleanup marker alone is not a pass.

## Standalone Native sustained execution

In a macOS arm64 repository development environment, select a real built `holo`:

```sh
HOLONOMY_NATIVE_TEST_EXECUTABLE=/absolute/path/to/holo \
  HOLONOMY_NATIVE_SOAK_MS=300000 \
  pnpm test:native:sustained
```

Duration is in milliseconds, accepts 185000–1800000, and defaults to 185000. This selects workload duration, not per-operation timeouts or authority. The case continuously performs filesystem, Crypto and loopback HTTP work across valid and invalid plugin configuration updates; success requires actual CLI exit and absence of the observed Runtime process. RSS/FD samples are observations, not a leak-free guarantee.

Node drives repository-side fixtures; the selected Native binary executes application JS with an empty `PATH`. Quick HTTP cancellation, cleanup and duration-boundary fixture tests run in `pnpm test:native:fixtures`; they do not replace a real sustained Native result.
