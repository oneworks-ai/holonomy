# Isolated Native diagnostic profiles (experimental)

[简体中文](observer-profiles.zh-Hans.md) · [Inline Observer](observer.md)

Standalone Rust/V8 `holo` can run an explicitly selected diagnostic module in a separate, capability-free process containing one V8 isolate. It uses the same binary, not Node or another product Runtime/Provider. This mode does not move or reinterpret existing `ctx.holo.observe` closures. Those remain trusted inline callbacks with their documented partial isolation.

## Configuration

Create an owner-private output directory before startup:

```sh
mkdir -p ./private
chmod 700 ./private
```

Create `host.json`:

```json
{
  "schemaVersion": 1,
  "sandboxPolicy": {
    "schemaVersion": 2,
    "diagnostics": {
      "sourceReader": "none",
      "maxSourceReadBytes": 0,
      "observerEvents": ["script.compiled"],
      "maxQueuedEvents": 32,
      "maxObserverCallbackMs": 1000,
      "retentionMs": 0
    }
  },
  "observerProfiles": [{
    "id": "monitor",
    "use": "./diagnostic.mjs",
    "export": "default",
    "config": { "minBytes": 0 },
    "registration": {
      "acceptHighCost": true,
      "events": ["script.compiled"],
      "maxQueuedEvents": 16,
      "callbackTimeoutMs": 1000
    },
    "sink": { "path": "./private/observations.jsonl", "maxBytes": 1048576 }
  }]
}
```

Create `diagnostic.mjs`:

```js
export default (event, config, sink) => {
  if (
    event.event === 'script.compiled' &&
    event.payload.sourceBytes >= config.minBytes
  ) {
    sink.publish()
  }
}
```

Create `index.mjs` and run:

```js
console.log('PROFILE_APP_OK')
await new Promise(resolve => setTimeout(resolve, 500))
```

```sh
holo --timeout 5000 --host-config ./host.json ./index.mjs
```

Guest stdout is `PROFILE_APP_OK`; inspect `private/observations.jsonl` as the Host owner. The example remains alive briefly to allow optional diagnostic work; a timer duration does not guarantee delivery. A short application may finish before queued events are processed. This is a lossy side channel, not complete or durable audit history.

## Module and registration contract

- Profiles are Host configuration, not Guest APIs. IDs are unique safe identifiers of 1–64 bytes; at most four profiles are installed. The reserved resource instance is `observer.<id>` and must not collide with an ordinary plugin.
- Sources reuse Native Host plugin resource admission and the current self-contained ESM/pnpm subset. The selected export is explicitly a diagnostic handler, **not** ordinary Cordis `apply`; initialization of an ordinary plugin is never replayed in this helper. A package may explicitly export a diagnostic entry, but arbitrary existing closures cannot be moved with their lexical state intact.
- The handler receives immutable JSON event/config copies and a callback-local `sink`. No Host Context, Gate, Provider, filesystem, network, Node or general Runtime APIs are installed. String generation, Wasm and dynamic import are denied. A returned Promise is supported; there is no general timer/network runtime in the helper.
- `sink.publish()` accepts no arguments and requests only the current original, normalized source-free event. It does not publish user-supplied JSON, derived metrics, configuration, source or Error objects. At most one successful request is accepted per callback; retained old sinks are fenced. An `event` record is written only after successful callback settlement within its deadline.
- Registration uses the existing Policy ∩ Native descriptor ∩ Host cap compiler. Script events require high-cost opt-in. The five optional Native event kinds and unsupported kinds are unchanged; see [Observer support](observer.md#support-and-bounds).
- Optional `integrity` pins the existing Runtime plugin **bundle** SHA-256, not merely the entry file. Source graphs are snapshotted for the Runtime; restarts reuse those bytes, not changed files. Config JSON is at most 64 KiB. Diagnostic source limits are 1 MiB/module, 4 MiB aggregate snapshots and 128 modules, separately checked before transport/instantiation.

All registrations, schema/integrity and source graphs are checked before helper user initialization. Every selected module must be ready before Guest entry. Invalid configuration, unsupported permissions, bad module/export or initialization failure rejects startup without executing Guest code. Host setup may already have created the explicitly requested private sink file.

## Isolation, deadlines and lifecycle

Each profile runs one callback at a time with a bounded queue. Callback timeouts use the effective 1–1000 ms budget. Initialization has a 2000 ms per-attempt deadline; at most two helper restarts are allowed, and Host readiness has a seven-second total bound. An earlier explicit Runtime deadline/cancel still wins. Standalone otherwise has no default overall Runtime deadline.

Timeout/fatal VM errors discard the diagnostic helper/isolate; the main authorization Host is not terminated and recovered with `CancelTerminateExecution`. Helpers have a 32 MiB V8 heap target and sampled 256 MiB resident guard, not an instantaneous process-RSS guarantee. Four diagnostic slots, including unreaped children, are independent of the schema-validator pool. Native initialization/callback output tokens, epochs and sequence checks fence stale results. Owner EOF, Runtime stop and cleanup revoke publication and terminate owned helpers; callbacks cannot keep Guest termination alive indefinitely.

Profiles are immutable for one Runtime. Ordinary plugin-array watch does not replace them; changing profile fields requires a new Runtime. Existing inline Observer callbacks and other trusted ordinary Host plugins can still affect/block their own authorization Host; selecting an isolated module does not magically isolate unrelated inline code. For managed execution, the owner can separately [install Service Native profiles](managed-observer-profiles.md), selected by logical `initialObserverIds`. Node function bindings remain separate and cannot install Native profiles.

## Private output

The sink path must be relative to `host.json`. Its existing directory must be owner-private `0700` beneath trusted, no-follow ancestors. The regular leaf must be `0600`, single-linked and exclusively locked. `maxBytes` is 1024–16777216. Malformed/incomplete history, unsafe permissions or changed identities fail closed; existing files are never truncated or automatically rotated. Choose a distinct file for concurrently running Runtime installations.

Each record has `schemaVersion:1`, random `sessionId`, safe per-session `sequence`, local `generation:1`, `profileId`, helper `epoch`, Unix-millisecond `observedAt`, and closed `status`. Status is one of `event`, `callback.started`, `callback.failed`, `callback.timeout`, `queue.dropped`, `profile.disabled`, `initialization.failed`. Callback records may carry the original `sourceEvent`; drop records carry a count. `callback.started` acknowledges prepared arguments immediately before user invocation, not successful completion.

Source events are bounded to 8 KiB and records to 16 KiB. The sink queue has at most 64 records; saturation is coalesced/countable and nonblocking. Capacity, I/O, history or identity failure disables output with a fixed diagnostic, not a Guest authorization change. No raw module source, JS error message/stack, Host Context, native PID or output path is added. Sink records are best effort, not synchronous durable source-read audit.

Module/config/sink names and inode identities are private to source admission before Guest loading. This protects module aliases; an explicit generic filesystem grant can still expose Host secrets, so do not grant those directories to Guest. Physical file ACLs alone do not isolate code running under the same OS user.

Current real execution evidence is macOS arm64. This mode is experimental and does not establish complete Native/M4 coverage, Android/Windows support or production-release readiness. The [bounded source reader and its audit](engine-gate.md#bounded-source-reader) are independent installations.
