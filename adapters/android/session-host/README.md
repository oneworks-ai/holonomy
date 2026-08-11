# Holonomy Android Session Host

[简体中文](README.zh-Hans.md)

`session-host` is the non-UI Android control host for long-lived Holonomy runtime sessions. It owns the typed v2 command model, logical-runtime supervision, output/result snapshots, idempotent command handling, app-private persistence, a random local-abstract socket transport, and a concrete owner-process service.

It deliberately does not own ADB discovery, device selection, APK installation, or a second JavaScript executor. The host application adapts `SessionRuntimeFactory` to the existing Android runtime engine.

## Integration boundary

The library manifest contributes `HolonomySessionSupervisorService` with `exported=false`. The host application's `Application` must implement `HolonomySessionServiceProvider` and return:

- a `SessionRuntimeFactory` that creates a fresh `SessionRuntimeInstance` for every logical generation;
- a `SessionNativeHostFactory` that returns a fresh native-host identity for every engine request;
- a `SessionRuntimeControl` on each instance that serializes opaque trusted controls onto that engine's runtime thread.

The module supplies `JsonSessionControlCodec`, `AndroidLocalAbstractSessionControlTransport`, and an app-private journal below `noBackupFilesDir/holonomy/session-v2`. The service publishes its unpredictable socket name only in the owner-private `control/endpoint.v2` state. Peer credentials are restricted to the app UID, adb shell, or adb root.

The library manifest declares the supervisor as a `specialUse` foreground service for targetSdk 35. It starts an ongoing low-importance notification before constructing runtime dependencies, so embedding applications should keep the merged foreground-service permissions/type/property and may customize channel presentation only by wrapping the integration at the application boundary.

For same-app ingress, create a random ID with `SessionIngressCommandIds.random()` and call `HolonomySessionCommandIngress.submit(command)`. It writes the complete command first and then starts the non-exported service with only `commandId`. The CLI-compatible bridge remains the existing exported `HolonomyRuntimeActivity`: it must accept only that random ID and forward an explicit `HolonomySessionSupervisorService.commandIntent`; it must never carry command JSON. ADB discovery of `endpoint.v2` must use the app-owned/debug-authorized path rather than a fixed socket name.

The supported isolation wire value is `runtime`. `isolatedProcess` is accepted by the typed schema so clients can negotiate it, but the supervisor rejects it with the stable `session.isolation_unsupported` code until a real process-isolation implementation exists.

Each runtime spec may include a strict `sandboxPolicy` v1. Omitting it is equivalent to:

```json
{
  "schemaVersion": 1,
  "network": { "access": "none" },
  "filesystem": { "access": "none" }
}
```

Network access is `none`, `mockOnly`, or `restricted`. The latter two require at most 64 canonical HTTP(S) origins, an HTTP(S)-only scheme subset, an explicit private-network choice, and bounded transport limits. `mockOnly` advertises only the mock capability and its passthrough is fail-closed; `restricted` is the only mode that may create a real Android network provider. Filesystem `sandboxed` is schema-valid but is rejected before runtime creation with `sandbox.capability_unsupported`; v1 executes only `none`.

The supervisor freezes the policy for the logical runtime, reuses it on restart, computes a stable digest, and derives the native principal internally from the Android process and runtime generation. Callers cannot provide a principal in command JSON. `SessionNativeHostFactory` receives the complete `SessionNativeHostContext` and must apply its exact policy rather than widening authority.

## Control semantics

Every command carries `runtimeId`, `commandId`, and, where applicable, `expectedGeneration`. Replaying an identical `commandId` returns the original reply/future; reusing it for a different command fails closed. `restart` advances the logical generation, creates a new engine/native-host chain, and fences output or exit callbacks from older generations.
Completed command/reply artifacts form a bounded recent replay window; in-flight commands are retained while the oldest completed entries are evicted to admit later lifecycle commands.

`control` carries only an operation name plus a bounded JSON value. Android never interprets network matching rules. Initial controls are delivered through the trusted runtime-thread seam after engine start and before the user entry module; later controls require the expected active generation.

Output events use a monotonically increasing per-runtime sequence. Status replies include the retained sequence window so a controller can detect an expired cursor and resume from the first available event.
