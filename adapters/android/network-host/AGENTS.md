# Android Network Host

This module is the Android native capability-provider owner for `host.network.http`. Keep JavaScript
Fetch behavior in the JavaScript web-standards package and keep runtime-thread/engine lifecycle in
`host-core` or `v8-host`.

## Public boundary

- `AndroidNetworkHostConfiguration` and `AndroidNetworkLimits` define provider-owned authority and
  resource limits.
- `AndroidNetworkProviderFactory` creates exactly one fresh complete `RuntimeNativeHost` per
  `AndroidNetworkProviderGeneration`. A trusted replacement replaces the whole provider; do not add
  public socket, TLS, resolver, connection or worker injection points.
- `AndroidNetworkObserver` is a lossy read-only side channel. Observations must remain immutable,
  copied, bounded and redacted. Never add paths, queries, headers, bodies, DNS answers, socket/TLS
  objects, provider tokens, call tokens or request IDs.
- Observer callbacks stay behind the bounded asynchronous dispatcher. Callback latency, exceptions,
  queue saturation and shutdown must not change provider results or block network work. Close clears
  queued summaries and the observer reference; queued callbacks never start after close.
- Authority, quota, DNS admission/pinning, resource ownership, cancellation, credits and disposal
  remain enforced by the active provider owner.

## Internal map

- `AndroidHttpNetworkHost.kt`: NativePort dispatch, exchange ownership/lifecycle and the private
  observation dispatcher. Its only public JVM constructor takes `AndroidNetworkHostConfiguration`.
- `AndroidNetworkProvider.kt`: public generation factory and observation configuration/enums.
- `AndroidNetworkObservation.java`: public immutable read model with a package-private constructor.
- `AndroidNetworkHostConfiguration.kt` and `HttpValidation.kt`: authority and bounded input rules.
- `NetworkTransportSeams.java`: package-private JVM transport seams, platform dependency assembly and
  the generation factory's private-constructor bridge. Keep the dependency-bearing host constructor
  private; Kotlin `internal` alone is not a Java/AAR visibility boundary.
- `AndroidNetworkAddressResolver.kt`, `PinnedHttp1Connection.kt` and HTTP/TLS helpers: provider-owned
  transport implementation. Do not add a public partial-injection constructor.

## Tests and gates

- `contract/`: NativePort contract and provider-factory behavior.
- `contract/AndroidNetworkProviderApiSurfaceTest.kt`: reflection plus `javap` gate for the AAR/JVM
  visibility boundary.
- `security/`: authority, quotas, observer redaction and bounded delivery.
- `lifecycle/`: cancellation, disposal, terminal-once and observer isolation.
- `transport/`: DNS-pinned socket/TLS/HTTP byte transport.
- `support/`: one shared deterministic harness; do not duplicate provider internals across suites.

Run from `adapters/android` with an Android SDK configured:

```bash
./gradlew :network-host:testDebugUnitTest --offline
./gradlew :network-host:assembleDebug :network-host:lintDebug --offline
```
