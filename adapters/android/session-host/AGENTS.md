# Android Session Host Guide

This module is the non-UI session-control boundary above `host-core`. Keep it independent of concrete V8/Javet, ADB discovery, and CLI implementations.

## Ownership map

- `SessionProtocol.kt`: protocol v2 value objects, commands, stable error codes, snapshots, validation limits, and immutable sandbox-policy authority.
- `AndroidRuntimeSessionSupervisor.kt`: multi-logical-runtime state machine, idempotency, generations, engine lifetime, output retention, and late-event fencing.
- `AndroidRuntimeSessionController.kt`: typed create/start/status/cancel/stop/restart/control/dispose facade over an in-process or transport-backed handler.
- `SessionRuntimeIntegration.kt`: the only runtime/native-host construction seams. Integrators adapt these to the existing engine implementation.
- `AppPrivateSessionCommandStore.kt`: bounded atomic artifacts rooted below an application-owned private directory; wire encoding remains injectable.
- `JsonSessionControlCodec.kt` and `LengthPrefixedSessionFrames.kt`: bounded v2 JSON and wire framing.
- `AndroidLocalAbstractSessionControlTransport.kt`: random local-abstract socket with peer-UID admission.
- `HolonomySessionSupervisorService.kt`: concrete non-exported foreground service, bounded owner notification, app-private endpoint publication, and commandId-only ingress.

## Stable boundaries

- Do not add ADB discovery, installation, device pooling, CLI fixture logic, or developer end-to-end assertions here.
- Do not instantiate V8/Javet directly or add a second JavaScript executor. Depend on `RuntimeEngine` through `SessionRuntimeFactory`.
- Android forwards opaque bounded control JSON through `SessionRuntimeControl`; it never implements network matching rules. Initial controls run before the user entry module.
- Missing `sandboxPolicy` means network/filesystem deny. Keep v1 parsing strict, canonical, and bounded; never accept a caller-supplied principal. Filesystem `sandboxed` remains schema-valid but stably unsupported.
- `SessionNativeHostFactory` receives policy, digest, internally derived principal, runtime generation, and native-host generation as one context. Embedders may narrow authority but must never widen it; mock-only passthrough cannot own real sockets.
- One logical runtime owns one active engine generation. Every restart gets a fresh engine and fresh native-host identity; callbacks must be checked against both runtime and generation.
- `isolatedProcess` stays schema-valid but returns `session.isolation_unsupported` until a separately reviewed process model, IPC lifecycle, and cleanup implementation exists.
- Transport owns local framing, peer checks, and message quotas. The supervisor owns typed command semantics only.
- The concrete service fixes its store below `noBackupFilesDir`; never accept a guest-provided filesystem path or publish the random socket outside owner-private state.
- Keep the targetSdk 35 foreground-service type/permission/property in the library manifest. Notification content is bounded Android integration state and must not include guest JavaScript data.

## Verification

Run the module's debug JVM tests through Gradle once the host build includes `:session-host`. Tests should use fake `RuntimeEngine`, `RuntimeProcessHost`, and `RuntimeNativeHost` seams; device instrumentation belongs to the integrating application rather than this core module.
