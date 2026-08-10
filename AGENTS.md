# Mobile Runtime Package

`@oneworks/mobile-runtime` owns platform-neutral JavaScript runtime behavior used by mobile hosts. Android, Javet and V8 bindings adapt to the package ports; they do not own JavaScript scheduling semantics.

## Entry points

- `src/event-loop/runtime-event-loop.ts`: task, next-tick, timer, native completion, liveness and shutdown state machine.
- `src/event-loop/types.ts`: minimal host port and public event-loop contracts.
- `src/git/`: authorized `host.git` v1 provider contract, opaque-repository JS facade and machine-readable support matrix.
- `src/child-process/`: restricted callback-only `node:child_process` facade that maps two literal `git` argv forms to `GitFacade`; it owns the first cancellation/timeout terminal and late repository close, accepts only genuine captured platform AbortSignals, and swallows callback throws to prevent internal unhandled rejections. It never spawns processes or interprets a shell.
- `src/http-server/`: bounded inbound `node:http` / `ws` server facade, NativePort contract and virtual-host provider.
- `src/event-loop/errors.ts`: stable runtime error codes.
- `src/crypto/`: bounded synchronous engine-internal crypto intrinsic port, guarded provider installation, `node:crypto` synthetic module, Web crypto installer and precise capability matrix.
- `src/module-loader/mobile-module-loader.ts`: canonical resolution, verified source loading, graph planning and module cache ownership.
- `src/module-loader/source-analysis.ts`: Acorn AST dependency/export analysis; do not replace it with regex or a private lexer.
- `src/module-loader/types.ts`: platform-neutral host port plus `ModulePlan` and engine-facing require/cache contracts.
- `src/module-loader/errors.ts`: stable resolution, integrity, package and evaluation-boundary error codes.
- `src/node-compat/`: bounded pure-JS Node Core v1 shims, immutable host snapshots, capability matrix and synthetic-module registry.
- `src/native-port/native-bridge.ts`: atomic admission, request/stream cancellation, Event Loop integration and quota owner.
- `src/native-port/native-resource.ts`: guest-opaque cross-request resource handle identity.
- `src/native-port/types.ts`: platform-neutral request, event, authority and credit contracts.
- `src/streams/`: memory-only Web and Node stream state machines, explicit bare-V8 globals, capability matrix and synthetic-module registry.
- `src/node-fs/`: virtual `mobile-fs://` authorities, the intentionally partial
  `node:fs` facade and the conformance-only in-memory `NativePort` provider.
- `src/storage/`: authorized binary KV, asynchronous SQLite and opaque credential-handle contracts over `NativeBridge`.
- `src/web-network/index.ts`: fetch/WebSocket shim, network authority, versioned operations and scripted provider.
- `src/index.ts`: public package exports.
- `src/runtime/`: M2 unified runtime composer. It owns one Bridge created from a caller-owned Event Loop and NativePort, composes only explicitly enabled reviewed leaves, and never installs globals into ambient `globalThis`.
  After disposal its operational facades, including all module-loader operations, reject `runtime_composer.disposed`; immutable loader limits/root URL and runtime module/global/capability/snapshot inspection remain available.

## Event-loop contract

- JavaScript callbacks execute synchronously on one caller-owned thread, and `runTurn()` is not reentrant.
- A turn drains a pre-existing next-tick queue, or runs at most one ready macrotask and then drains next ticks. Each non-idle turn that remains active ends with exactly one host microtask checkpoint.
- Ready macrotasks, native completions and timers are selected by ready time, then insertion order.
- A native completion is admitted only while its request is pending. Unknown, canceled, late and duplicate completions are rejected without running their callback.
- Intervals use fixed-rate deadlines and skip missed occurrences instead of burst catch-up or callback-time drift.
- Unreferenced work can run opportunistically but does not keep the loop alive or request a host wakeup by itself.
- The loop enforces a per-turn JavaScript callback budget. Promise microtask checkpoints have the void semantics exposed by V8/Javet; runaway Promise execution is terminated by the engine watchdog or deadline, not by fabricated queue counts.
- `shutdown` / `dispose` are idempotent, cancel pending work and reject new admissions. Shutdown during a callback stops the turn before next ticks, the microtask checkpoint or wakeup reconciliation.
- Lifecycle observers tear down attached runtime subsystems before host termination. Wakeup failures are fatal and roll back the admission that cannot be returned to its caller; `getCurrentTime()` remains the only subsystem adapter to the validated monotonic clock.

## Native-port contract

- Guest requests use only `{ id, module, operation, args, deadlineMs?, binary? }`; runtime-injected principal and capabilities travel out-of-band in a frozen dispatch context and are never accepted from guest input.
- Providers must re-authorize the injected authority immediately before execution. A bridge-side check is not a substitute for provider authorization.
- Each admission receives a non-reusable provider-only `callToken`. Guest IDs can be reused after local cancellation, but dispatch, cancel, credit, resource close and late sink identity remain bound to the original token/generation.
- Every admitted call registers one referenced Event Loop native request. Unary provider terminals become native-completion macrotasks; stream chunks, stream terminals and provider resource revocations become ordinary macrotasks. Provider data is never delivered outside a loop turn, and the loop owns the post-turn microtask checkpoint.
- The first terminal that executes wins exactly once. Queueing a provider terminal locks out later provider sinks but retains its deadline and AbortSignal until Event Loop delivery; ready time decides terminal-versus-deadline ordering, while abort, direct cancellation or disposal can still win before delivery.
- Streaming providers may emit a chunk only after `grantCredits`; the bridge caps per-stream and aggregate outstanding credits. A reader is removed only after chunk output reservation succeeds, so reservation failure rejects that reader through the selected terminal. Stream close releases its request, binary, stream-handle and credit reservations.
- JSON-safe inline values and copied `Uint8Array` / `ArrayBuffer` payloads are admitted under pending, inline, per-payload and host-wide quotas. Output binary is preflighted before copying, retained only from provider sink admission until its loop callback hands the isolated copy to the guest, then released from Bridge accounting.
- Provider resource grants create controller-owned opaque handles only in the delivery turn. Handles are bound to principal, controller, originating call token, type and provider token; later request arguments resolve them through provider-only context bindings. Providers match the exact reference-object identity shared by normalized `request.args` and `context.resources`, never a guest-forgeable structural tag. A provider token is a bounded branded string used only inside the same-process provider side table; it is excluded from guest values and any later JNI/platform request envelope. A malformed provider event is still scanned through a bounded own-data descriptor extractor: resources are checked by safe length and sequential numeric descriptor, so a later accessor or invalid descriptor cannot erase the already verified prefix and no provider getter runs. The v1 boundary intentionally ignores unknown provider keys: event, grant, resource-event and Bridge-option validation reads only fixed named own-data descriptors, never enumerates object keys, and oversized lists stop before index walks. Duplicate or same-owner token collisions select `protocol_error`; only that call's exposed handle or queued reservation is atomically invalidated before its token is closed. A different call's retained handle remains open and the colliding provider grant is rejected without a bridge-side close because the scalar cannot be safely attributed. Every rejected grant set first locks its error terminal, then pushes each unique token into a per-call bounded iterative `undelivered` close queue, then cancels once. The first locked terminal is immutable. Only synchronous close/cancel reentry inside that cleanup window may append grants to the same queue; ordinary post-terminal sinks are opaque and ignored. Grants beyond the hard cap remain the provider's post-cap cleanup responsibility.
- Provider errors cross the boundary only as a stable domain/code pair plus bounded `resource` / `retryable` details. Runtime errors and the minimal FS (`not_found`, `exists`, `permission_denied`) and Network (`unavailable`, `timeout`, `connection_refused`) domains never carry a platform message, exception or path.
- Request/options/authority use strict own data-property snapshots. Admission reentrancy, clock or signal failure rolls back Event Loop registration, timer/listener state and all counters before dispatch. All `NativePort` methods may return `void | Promise<void>`; every rejection is consumed and guest-visible failures use stable codes.
- A later adapter may translate these local types to `@oneworks/runtime-host-protocol`, but this package must not import that central ABI or make it the owner of guest/runtime lifecycle state.

## Boundaries

- Do not import Android, JNI, Javet, V8, Node core shims or runtime protocol packages here.
- `src/http-server/` owns inbound virtual listener, request/response and accepted WebSocket state only. Native providers own sockets and TLS; the memory provider is conformance-only.
- The host only supplies a monotonic clock, wakeup scheduling, a microtask checkpoint and termination.
- Module loading and native port implementations belong in their own leaf directories and must not move scheduling state out of `src/event-loop/`.
- Stream shims reuse the frozen `EventEmitter` and `Buffer` implementations, own no host I/O, and expose their separate synthetic-module bindings for loader composition.
- Web Stream constructors are never read from ambient globals; mobile hosts explicitly inject `createWebStreamsGlobals()` into the engine context.
- `src/node-fs/` never accepts a guest principal, capability or provider root id.
  It sends versioned `host.fs` operations only; providers re-authorize the
  bridge-injected authority and use V4 opaque resource bindings for file
  handles. The memory provider is test-only, not an Android implementation.
- Atomic `writeFile` uses a provider-owned `fs.atomic-write` opaque resource.
  Staged bytes stay in a provider-private table outside every directory
  namespace; commit atomically replaces the target, while close, cancel,
  undelivered grants and disposal roll back an uncommitted transaction.

## Storage contract

- `src/storage/` composes Native Bridge v4; it never creates a second request, cancellation, deadline, quota or resource controller.
- `host.storage` v1 sends only bounded binary KV, asynchronous SQLite and credential-handle operations. Principal, capabilities and provider namespace allocation travel out-of-band; providers re-authorize before each operation.
- Credential material is never enumerated or serialized. Bridge-issued `storage.credential` handles expose only `withBytes`; its temporary callback copy is zeroed best effort after use.
- Providers own per-database FIFO scheduling and transaction exclusivity; every failed or cancelled transaction rolls back. This leaf has no Android/JNI/Room/Keystore/SQLite wiring, persistence implementation, SQL parser, migrations, synchronous `node:sqlite`, shell or native paths.

## Git contract

- `host.git` composes the existing FS authority, HTTP(S) Network authority and Native Bridge; it does not own a second request lifecycle, credential store, virtual path parser or network policy.
- Repository identity is a Bridge-issued `git.repository` opaque resource. The provider owns its repository token, Git-specific quota and read/write lock; the facade never exposes or serializes that token.
- Provider adapters must re-authorize the injected principal/capabilities, operation, repository binding, virtual path, resolved remote/redirect and credential reference immediately before work. Guest data never carries authority or credential material.
- V1 supports authorized repository open, bounded status, allowlisted repository config reads, redacted remote listing, and progress-bearing clone/fetch/push. Clone paths are `mobile-fs://workspace` URLs and remote transport is HTTP(S) only.
- Native Bridge remains the owner of cancellation, monotonic deadlines, call identity, progress credit, late-event rejection, generic in-flight quota and disposal. Git providers own `maxOpenRepositories`, transfer/progress limits and shared-read/exclusive-write repository locks.
- Errors cross the facade only as stable `git.*` codes and fixed messages. Provider/native messages, URLs, paths, remote responses and exception classes are never exposed.
- Arbitrary shell/argv, hooks, native credential helpers, environment/home/keychain reads, raw config writes/listing, arbitrary refspecs, deletion pushes, SSH/scp/git/file transports, commit/checkout/worktrees/diff/history/submodules and native paths are explicitly unsupported.
- This package does not contain Android or JGit wiring. A later host adapter implements `NativePort` according to `GIT_PROVIDER_CONTRACT`; `GIT_CAPABILITY_MATRIX` is not a wiring advertisement.

## Crypto contract

- `CryptoPrimitivePort` is the only synchronous engine-internal crypto intrinsic boundary. It includes a CSPRNG/entropy contract, does not use `NativeBridge`, and never admits guest-directed filesystem, network, Binder or Keystore I/O.
- `src/crypto/primitive-port.ts` remains the only public context/state lifecycle owner; `primitive-*.ts`, the AES/GCM leaves and the Node facade leaves are private stateless operation or algorithm responsibilities and must not become alternate public ports.
- The port owns strict bound-once provider snapshots, internal-slot byte preflight, copied admission/output, opaque context identity, per-context and aggregate quotas, provider non-reentrancy poisoning, stable redacted errors, context cleanup and adapter-wide `dispose()` backstop.
- The trusted provider must complete every operation in the current call stack and must never construct or return a Promise or thenable. A violating host owns observing every rejection before return; runtime detection remains fail-closed and does not inspect an arbitrary `then` getter. Android integration therefore exposes a synchronous JCA adapter on the runtime thread rather than futures, callbacks or asynchronous wrappers.
- Provider installation must pass the required-now primitive self-test before module namespaces, Web globals or capability descriptors are created. The leaf does not claim Android/JCA wiring; Android entropy warm-up, `RuntimeThreadGuard` and JCA installation remain host responsibilities.
- The deterministic pure-JS provider and AES implementation are testing-only internal files and are not exported by `src/crypto/index.ts` or the package root. They are never production entropy or crypto providers.
- Crypto shims reuse `RuntimeBuffer` and the package encoding boundary; they never depend on ambient `Buffer`, `TextEncoder` or `crypto` globals.
- Temporary key, IV, AAD and tag copies are zeroed on a best-effort basis after synchronous provider admission; the runtime does not claim cleanup after fatal OOM or engine termination.
- `CRYPTO_CAPABILITY_MATRIX` is a static contract, not a wiring advertisement. Successful installation emits semver `1.0.0` descriptors with `host.crypto` supported primitives and `node.crypto` / `web.crypto` mapped to `host.crypto`; plugin requirements must explicitly set `acceptHostMapped`.

## Web-network contract

- `host.network` v1 carries metadata as bounded JSON and body bytes as binary handles; response streams advance only on Native Bridge credit.
- Runtime-injected `NetworkAuthority` is immutable and never accepted from guest request data. Every provider must independently re-authorize module, operation, method, raw headers, URL, strictly parsed resolved IP address, connection slot and byte limits.
- The reference provider is deterministic test infrastructure only. It must never resolve names, open sockets or delegate to a host fetch implementation.
- Fetch owns redirect revalidation, connection leases and response body lifecycle. Native Bridge v4 owns call-token generation, resource identity, deadline delivery, liveness, output quotas and late-event admission. Network translates injected or fallback AbortSignal events only through Bridge v4's explicit cancel/stream-close API; it never passes a synthetic signal across the Bridge's ambient constructor boundary or reproduces Bridge liveness.
- HTTP response resources are Bridge-issued `NativeResourceHandle` objects. Operations pass the object in args; providers re-authorize the corresponding exact `context.resources` binding. WebSocket client/server are deferred in M2 fetch v1 and declared unsupported by the capability matrix.
- The reference HTTP provider enforces `accepted → uploading → response → reading → closed`, rechecks response chunk/aggregate limits before streaming, and releases its connection slot exactly once at terminal resource close. Its scripts can emit malformed deterministic fixtures for negative tests but never perform external I/O.
- The Bridge adapter closes every unexpected output resource grant before parsing. Fetch and stream continuations carry a dispose generation; stale terminal/chunk delivery resolves only as cancellation and cannot return a live response. Header limits apply to final outgoing entries, while provider response limits still count raw entries before merge.

## Module-loader contract

- `app:` is the only source-backed scheme. Every source URL stays under the configured app root; `node:` resolves only through the host synthetic registry.
- The host returns bytes plus a lowercase hexadecimal SHA-256. The loader hashes those exact bytes, decodes them as fatal UTF-8, then parses and caches the verified source. Host failures are mapped to stable public errors without forwarding native exceptions.
- Production package resolution considers `import` / `module` / `default` or `require` / `default`. Workspace `__oneworks__` / `source` conditions require the explicit `source` resolution profile.
- Only `.js`, `.mjs` and `.cjs` are admitted by default. JSON requires explicit opt-in; TypeScript and unknown extensions fail closed.
- Package conditions, Acorn-derived dependency graphs and cache identity are deterministic. Query strings remain part of module identity.
- Production parsing calls the lockfile-pinned Acorn parser directly. `source-analysis.ts` has one non-exported-from-package test seam solely for deterministic parser-capacity normalization; do not expose it through public loader options or package entry points.
- Planning and engine evaluation are separate. Android/Javet/V8 consumes `ModulePlan` and the loader's require/evaluation-cache contract without reimplementing resolution.
- Resolution and planning may await the host. Public `resolve` / `createPlan` / `load` calls enter one FIFO cache transaction; recursive resolution reuses that transaction, and failures remove only keys first published by it.
- `MobileModuleLoaderLimits` is descriptor-snapshotted and frozen per loader. Only its six plain, own, enumerable data properties are admitted; accessors, symbols, unknown keys, exotic prototypes and exceptional proxies fail without invoking user getters.
- Source, per-plan total bytes, module/dependency count and Acorn AST node/depth budgets fail with one stable resource-exhaustion code before unsafe work continues.
- Acorn analysis uses an iterative, quota-bounded walk with lexical scopes. Only unbound global `require` and `process` identifiers activate Node-specific admission checks.
- `createRequire` remains synchronous by admitting only resolutions already recorded while building a plan. Synchronous require/evaluation cache access is unavailable while an async plan transaction is active, so engine code cannot observe cycle placeholders.
- `HostModuleLoaderPort.readModule` must never reenter public loader APIs. Calls before the HostPort function returns are rejected directly; asynchronous host implementations use the supplied read-context rejection facade instead of capturing the loader across `await`.
- Native addons, `dlopen`, filesystem, network and Node core implementations are outside this package.

## Node Core contract

- Node Core compatibility remains POSIX-only. URL/process/OS file-like values are virtual-root bounded, while `node:path` is deliberately lexical and the future filesystem authority must enforce sandbox checks before I/O.
- Shims must not import `node:*`, expose real Android paths or identities, or silently accept unsupported process controls.
- Module loaders consume `createNodeCoreSyntheticModules()` and must not depend on shim-private implementation files.
- Loader bindings are derived from those namespaces through `createNodeCoreSyntheticModuleBindings()`; never maintain a second export-name list by hand.

## Verification

- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- `pnpm lint`
- `pnpm format:check`
