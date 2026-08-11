# Android Network Provider

[简体中文](./README.zh-Hans.md)

`network-host` supplies the Android native `host.network.http` capability. It owns authority checks,
request quotas, DNS admission and pinning, socket/TLS transport, cancellation, resource ownership,
stream credits, and disposal. JavaScript Fetch semantics remain in the JavaScript web-standards
layer.

## Default provider

Create one provider for each logical runtime generation and pass the returned `RuntimeNativeHost` to
that generation's engine composition:

```kotlin
val factory = AndroidNetworkProviderFactory.default(
    configuration = AndroidNetworkHostConfiguration(
        principal = "app-runtime",
        allowedOrigins = setOf("https://api.example.com"),
    ),
)

val nativeHost = factory.create(
    AndroidNetworkProviderGeneration(runtimeId = "worker-a", generation = 1),
)
```

Each `create` call must produce a fresh host. The factory rejects reuse of the same provider identity
across generations so resources, cancellation and disposal cannot cross a generation boundary.

## Read-only observations

A trusted embedder can receive asynchronous summaries without gaining access to provider controls:

```kotlin
val factory = AndroidNetworkProviderFactory.default(
    configuration = networkConfiguration,
    observation = AndroidNetworkObservationConfiguration(
        observer = AndroidNetworkObserver { summary ->
            diagnostics.record(summary.kind, summary.terminalState, summary.elapsedMs)
        },
        maxPendingObservations = 64,
    ),
)
```

Summaries contain only the runtime generation, an exchange sequence, origin, method, status, byte
counts, elapsed time and stable terminal state/error. Paths, query strings, headers, bodies, DNS
addresses and transport objects are never exposed. Delivery uses a bounded asynchronous queue;
overflow is dropped, observer failures are isolated, and a slow observer never back-pressures a
request.
Closing the provider clears pending summaries and releases its observer reference; an already-running
callback may return, but queued callbacks do not start after close.

## Trusted replacement

An embedder that must replace transport policy can supply the complete provider:

```kotlin
val factory = AndroidNetworkProviderFactory.replacement { generation ->
    CompanyNetworkProvider(generation)
}
```

The replacement is the provider owner. It must implement the complete `RuntimeNativeHost` contract
and retain authority, quota, DNS pinning, resource binding, cancellation, stream-credit and disposal
enforcement. Internal socket, TLS, resolver and worker seams are intentionally not public extension
points. Observation configuration applies to the default provider; a replacement owns its own safe
diagnostics behavior.
