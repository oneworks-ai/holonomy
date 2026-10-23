# Native Host execution boundary

## Current ownership

Each invocation remains an isolated Runtime **process**. When Host configuration is present, it owns two independent V8 isolates on separate native threads:

- The Guest isolate executes the shared Runtime and user modules. `HostState.remote` owns its transport client, Guest promises/callbacks and NativePort sinks; its `control` is absent.
- The Host worker isolate owns the unique Control JS, compiled Policy, Kernel, Cordis plugin app, providers, native handles, plugin module graph/cache, config watch and Host timers. Its `HostState.control` exists; `remote` and Guest `SourceStore` are absent.
- No `v8::Global`, JS object, Error, Function or Promise crosses threads. Only the documented thread-safe isolate interruption handle is shared for termination.

Explicit `observerProfiles` may add dedicated same-binary helper processes, each with a capability-free diagnostic isolate. They do not share the Main Host's JS state or bootstrap another product Runtime/Provider. Only exact module plans, immutable JSON event/config copies and fixed typed outcomes cross the private bounded socket. Sink publication selects only the current original normalized metadata event; errors/config/source cannot become arbitrary output.

`src/control.rs` routes to responsibility leaves:

- `state.rs`: Host-only ControlState and Guest-only delivery records.
- `native.rs` / `calls.rs`: trusted Host bootstrap, local Host calls and native Provider/plugin-source callbacks.
- `transport.rs`: closed command methods, owned `Send` payloads, byte leases and shared liveness/interrupt state.
- `worker.rs` / `worker_loop.rs`: create/drive/destroy the Host isolate on its owner thread, including Host microtasks, plugin imports, timers, network and watch, even while Guest JS is busy.
- `remote.rs` / `guest_sync.rs`: Guest-side bounded transport, sync/Gate waits, readiness and shutdown.
- `guest.rs` / `protocol.rs`: generation-bound monotonic IDs and opaque promise reservations. Host reserves before side effects. Both ledgers reject duplicate/replayed IDs; unknown/late completions cannot affect live calls.
- `pump.rs` / `value.rs`: Host result capture and Guest-only resolver delivery. Arbitrary Host values are never stringified; rejected reasons and stacks are replaced with fixed errors.
- `events.rs` / `port_bridge.rs`: Guest-only delivery of serialized resource and NativePort events.
- `bootstrap/event-batch.mjs`: count and final JSON UTF-8 byte bounds, including Base64/escaping; dequeue only after the transfer string passes validation.

## Bounds and lifecycle

- Current process-per-run generation is 1. Each side permits 256 ordinary pending calls plus one reserved `close` slot.
- Command queue has 264 slots and a 256 MiB aggregate queued-byte ceiling. Zero-byte cleanup admission remains possible at ordinary byte saturation; queued leases release on acceptance or failed send.
- Host completion capture preserves the pre-callback admission cutoff and request ordering. Each batch is at most 64 completions and 64 MiB. One batch may be in the channel and one in the local outbox; full output transport stops additional result copying, not Host progress.
- Guest liveness combines its pending/port/event state with Host active state. A separate busy hint selects 1 ms for real work and 20 ms when only plugin watch keeps the Runtime alive.
- The bootstrap handshake reads strict per-kind Gate timeouts from the shared compiled Policy **before plugin installation**, freezes them in the native client, and rejects missing/unknown/invalid fields. Gate wait starts before enqueue, uses its local remaining deadline and rejects late replies. A dedicated async Gate command keeps Host progress independent of the blocked Guest.
- `gates.rs` owns Host-side decision Promises and private native replies. `monitor.rs` is driven by the existing watchdog: timeout cancels one Gate; a missing cancellation acknowledgement after 100 ms fails the unresponsive generation and interrupts both isolates. Terminal acknowledgement is published before waking the waiter.
- The global runtime watchdog interrupts both isolates. Synchronous waits check stop/cancel at most every 5 ms (or sooner at deadline). Owner control-pipe EOF uses the same cancellation path.
- On Guest terminal/close, ordinary Guest reservations and callbacks are withdrawn; closing drives only the private cleanup promise, never Guest timers, imports, user microtasks or resource callbacks.
- Native shutdown interrupts the Host and bounds joining to one second. V8 interruption does not claim to kill a blocking OS syscall. If it does not join, this isolated Runtime process is failed and must exit; no caller may reuse that generation. `v8-host::run` is an internal isolated-process entry, not an in-process multi-runtime embedding API.
- Host initialization/runtime exceptions cross as fixed errors. Normal close remains owned by the single Kernel/plugin/provider lifecycle; failure teardown is backed by native resource destruction.

## Engine Gate pipeline

`ctx.holo.engineGate` contributes to the shared `RuntimeEngineGateRegistryV1`, a separate decision pipeline under the same Cordis app. Policy runs first. Capability and Gate scopes are prevalidated and synchronously published under one revision, without an intervening await or user callback. Both drain before retired plugins and native module graphs are released.

`engine-gate-dispatch.ts` separates decision from settlement: deny/abort can return promptly, but every started frame (including unawaited next) retains the revision until its Promise settles. Frames register before running user code. Late continuations cannot advance or restore allow. A nonsettling trusted handler retains capacity/old graph and requires Runtime restart; cancellation is not a claim to kill a Promise. Native isolate teardown remains the terminal backstop.

String hooks copy UTF-16 internal slots and require exact UTF-8 conversion before hashing. Lone-surrogate source is denied rather than aliased by lossy conversion; escaped source remains valid. Native V8 continues original source in the original Context; eval/Function details and callsite/origin remain unavailable.

Wasm uses native BufferSource internal-slot staging and the shared Gate. Streaming APIs first validate and bound a genuine shared Response body, then use that same stage; compilation is not incremental. Dynamic imports use private module-planner Contexts and HDO importer identity, then the same Gate decision owner. The explicitly selected Host-only reader uses a private byte-prefix Gate field for strings, verified Wasm bytes and source-bearing planned modules; synthetic modules have no reader. Native Inspector registers only the Guest Context and passes executable commands through Policy/Gate. Its sourceURL is only a client label and never authoritative origin; Service Inspector leases reuse that same Native Gate and existing lifecycle Registry; complete M4 coverage remains unfinished.

## Diagnostic and inspection side channels

`bootstrap/native-observer-platform.mjs` owns the exact partial platform descriptor and Host caps consumed by Native registration and Service admission. `bootstrap/native-observer.mjs` binds the shared Observer registry. `observer.rs` emits actual module/CJS compilation, explicit execution-root and Runtime terminal metadata, not a synthetic event from Gate allow. Its dedicated 64-slot/8 KiB owned-message channel never takes command capacity. Shared subscriber queues, callback timers and generation fencing remain Kernel-owned. Unreferenced Host Observer timers must not keep Guest terminal delivery open. Inline Host callbacks can block indefinitely: generation termination requires an explicit Runtime deadline, cancellation or another fatal watchdog condition; standalone defaults to no deadline. An async timer does not isolate those inline closures; the separately selected profile executor is described below.

`CancelTerminateExecution` is not a rollback of Host plugin or Kernel state. A terminated callback may already have mutated captured objects; do not treat a simple subsequent script's success as proof that authorization state is reusable. Arbitrary callback closures/objects cannot be moved to another isolate or reconstructed from source text with the same lexical identity. A diagnostic-only executor needs an explicit source/entry contract and owned metadata messages, not replay of ordinary Host plugin initialization. Current Host plugins have no installed bounded Host-owned log/event export route; a V8 console object or fixed observerDiagnostic output is not a configurable event exporter.

The experimental profile mode provides that separate explicit diagnostic entry and an owner-private bounded JSONL sink, without changing inline callback semantics. Core labels config/selected entries/sink before Guest SourceStore metadata setup; Host preflight must plan and label the full profile dependency closure before the first Guest planner/source-byte read. No profile user code runs in preflight. Registration, schema and integrity validation precede helper execution, and all helpers must be ready before Guest entry. SourceStore construction pins/checks metadata only; do not confuse it with source collection.

Profiles are immutable during ordinary plugin watch. Helper initialization is at most 2000 ms per attempt, with two bounded restarts and a 7 s Host ready budget; effective callback deadlines remain 1–1000 ms. Tokens, epochs and owner EOF fence late publication. Timeout/fatal helper errors discard that process/isolate, never recover the authorization Host. Four diagnostic slots (including unreaped children) are independent of the schema-validator pool. Memory RSS is sampled, not an instantaneous bound. Native shutdown must not join indefinitely on user code or output I/O. The shared metadata file primitive retains private source roles, strict identity/lock and append bounds; explicit generic FS grants are still Host-owned exposure decisions.

Readiness is per helper: a mix of `starting` and `ready` remains pending under that same deadline. Only an all-ready snapshot admits bindings/subscriptions; failed, closed and unknown states fail closed. Do not treat independent helpers' different initialization/restart timing as a protocol failure.

Network request-body inspection uses a separate explicit Host installation and `selectCapabilityBranchV1`; Kernel revalidates the selection against Policy/process/generation. Raw bounded Base64 travels as a private owned async argument, never in invocation JSON. Reader activation, deadline, one-shot/read quota, aggregate staging limits, revocation and best-effort zeroization have one owner in the shared Kernel/Network package. Provider contexts omit these Host-only inspection bindings.

## Gates

Run `cargo test --locked --workspace --release`, Clippy with warnings denied and Rust fmt. `tools/native-cli/tests/host_worker.rs` proves Host progress during busy Guest execution, startup barriers, global/local Gate deadlines, exception isolation and owner EOF using real `holo`. Preserve all native FS, HTTP/TLS/Abort, watch/old-graph, Crypto and Node-free executable tests. Plugin Host stderr and Guest stdout are independently scheduled: tests may not assume cross-pipe ordering, but must retain their semantic ordering assertions.
