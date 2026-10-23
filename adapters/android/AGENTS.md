# Android Adapter Tests

Android contains three native adapter responsibilities. `host-core` and `v8-host` form the native engine host: they own the runtime thread, engine construction, generation-bound NativePort transport, Inspector transport and teardown. `network-host` and `capability-host` execute admitted Host capabilities. Optional Backend modules such as `process-backend-v86` compose with those hosts without becoming ambient defaults; v86 owns its trusted V8/Linux VM, digest-bound assets and generation teardown. None of these modules owns public JavaScript Fetch, timer, filesystem or `node:child_process` semantics.

Android instrumentation may verify APK packaging, engine/native transport, Backend assets, generation restart and teardown. Public JavaScript API behavior must execute as a shared JavaScript conformance case; Kotlin only starts the Runtime and checks its test-runner terminal summary.

`runtime-host/` owns the production JS bootstrap and AAR asset packager; `e2e/` is only its diagnostic/test wrapper. `crypto-host/` owns synchronous JCA primitives behind the engine-only Crypto port. `storage-host/` owns asynchronous binary KV I/O behind shared NativeBridge/Broker selection; never dispatch storage disk work through the synchronous Capability callback. Optional modules require explicit Host installation and grant no ambient authority.

## Test topology

- `host-core/src/test/.../contract/`: the engine-facing host contract and stable errors.
- `host-core/src/test/.../engine/`: runtime-thread scheduling primitives such as native timers.
- `host-core/src/test/.../lifecycle/`: generation, termination, wakeup and disposal races.
- `capability-host/src/test/.../contract/`: strict filesystem open flags, rights and native file-handle contracts. Real Android JSON/NativePort wiring remains instrumentation evidence.
- `e2e/tools/__tests__/*.test.mjs`: Host bootstrap dispatch glue, run through the adapter-local Vitest configuration. Controlled Kernel seams do not count as real Javet/device execution.
- `runtime-host/tools/__tests__/*.test.mjs`: production bootstrap assets/composition and asynchronous storage cancellation/settlement. The default Android unit command includes this separate VM-module owner suite.
- Guest-conformance helpers must be checked against the actual shared resource facade (for Process, `guest-child-process-events.eventTarget`), not only a richer Node EventEmitter mock. Optional local listener removal must never prevent Promise settlement; logical deactivation is not physical Host-resource reclamation.
- `v8-host/src/test/.../engine/`: V8/Javet construction and architecture mapping; Inspector-specific tests stay in `engine/inspector/`.
- `v8-host/src/main/cpp/android_engine_gate.cpp`: pinned Javet/V8 per-compilation string/Wasm callback bridge. It only transports a synchronous decision to the Host-owned `RuntimeEngineGate`; Policy, UI, and product grants stay outside this native layer. Every restart must receive a fresh Gate identity and uninstall the old callbacks before closing V8.
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
