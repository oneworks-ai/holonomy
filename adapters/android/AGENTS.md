# Android Adapter Tests

Android contains three native adapter responsibilities. `host-core` and `v8-host` form the native engine host: they own the runtime thread, engine construction, generation-bound NativePort transport, Inspector transport and teardown. `network-host` and `capability-host` execute admitted Host capabilities. Optional Backend modules such as `process-backend-v86` compose with those hosts without becoming ambient defaults; v86 owns its trusted V8/Linux VM, digest-bound assets and generation teardown. None of these modules owns public JavaScript Fetch, timer, filesystem or `node:child_process` semantics.

Android instrumentation may verify APK packaging, engine/native transport, Backend assets, generation restart and teardown. Public JavaScript API behavior must execute as a shared JavaScript conformance case; Kotlin only starts the Runtime and checks its test-runner terminal summary.

## Test topology

- `host-core/src/test/.../contract/`: the engine-facing host contract and stable errors.
- `host-core/src/test/.../engine/`: runtime-thread scheduling primitives such as native timers.
- `host-core/src/test/.../lifecycle/`: generation, termination, wakeup and disposal races.
- `v8-host/src/test/.../engine/`: V8/Javet construction and architecture mapping; Inspector-specific tests stay in `engine/inspector/`.
- `v8-host/src/test/.../lifecycle/`: native-host generation identity and restart/close behavior.
- `network-host/src/test/.../contract/`: versioned NativePort schema, authority/resource binding and provider-visible results.
- `network-host/src/test/.../transport/`: pinned DNS/socket/TLS/HTTP framing and byte transport.
- `network-host/src/test/.../lifecycle/`: cancellation, deadlines, watchdogs, close/dispose and late-event races.
- `network-host/src/test/.../security/`: private-network policy, managed inputs and bounded quotas.
- `process-backend-v86/`: optional production v86/Linux Process Provider, Host bridge and asset packager; keep direct VM probes in `e2e/`, not production implementation classes.
- A module-local `support/` may hold a single shared deterministic seam. Do not copy large harnesses across responsibility directories.

`e2e/src/androidTest/` is Adapter instrumentation. `engine/` proves the real Android engine composition, `engine/transport/` proves NativePort transport, `engine/inspector/` proves the real Inspector socket, and `session/lifecycle/` or `session/security/` proves Android session boundaries. These cases do not start through `holonomy run` or `holonomy test`, so they are not developer CLI E2E and do not count toward common conformance coverage.

Do not create a centralized Android tests module or placeholder provider directories. Keep tests beside the production module that owns the behavior, preserve the production package when internal visibility is required, and use the smallest native protocol call or JavaScript probe that demonstrates the adapter boundary.

## Verification

- `pnpm test:adapter:android:unit`
- `pnpm test:adapter:android:device` only when an already-authorized emulator or physical device is available; report emulator and physical-device evidence separately.
