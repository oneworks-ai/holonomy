# Holonomy Service module guide

`tools/service/` owns the machine-level control plane. It is the only layer that persists device,
runtime-process, operation, inspector, and network-rule resources. Root CLI commands call the public
client; they must not fall back to direct ADB or host runtime execution.

## Stable entry points

- `index.mjs`: public library exports.
- `entry.mjs`: detached daemon process entry.
- `service-process.mjs`: local singleton `ensureHolonomyServiceProcess()` launcher.
- `service-client.mjs`: local-auto or explicit-remote client.
- `server.mjs`, `router*.mjs`, `openapi*.mjs`: authenticated HTTP/OpenAPI admission.
- `control-core.mjs`, `control-runner.mjs`, registries: persisted resource lifecycle.
- `service-log-*.mjs`, `process-output-*.mjs`: retained logs, retrying adapter output pump, and SSE summaries.
- Log records preserve arbitrary transport chunks, not line boundaries. Public journey assertions use `__tests__/native-log-text.mjs` to reconstruct text separately per generation/stream, including negative private-marker checks; never infer a missing diagnostic from a single chunk substring check.
- `device-watcher.mjs`, `process-reconciler.mjs`: daemon-owned discovery and crash cleanup fencing.
- `android-emulator-*.mjs`: daemon-owned AVD identity, start/stop/restart, and crash recovery.
- `mutation-coordinator.mjs`: durable idempotency for direct side-effecting mutations.
- `process-stop-registry.mjs`: the single atomic stop-process publication owner for both stopped and failed outcomes. Its transaction checks generation, operation target and active ownership, preserves an already selected natural terminal/exit, and clears only matching stop ownership. `control-runner.mjs` owns OS stop attempts and terminal operation error fencing; bounded retries handle transient writes, not a guarantee under permanently poisoned storage.
- `*-target-adapter.mjs`: Node, Android and opt-in Native execution adapters. Native uses the Rust binary's existing `__runtime` launch/owner-EOF pipe, never a Node Runtime child.
- `native-runtime-installation.mjs` owns the single strict owner-only Native installation reader, including optional deviceProvider and diagnosticSourceReader selections. The path-only helper retains its existing return contract. Startup passes selected metadata privately through manager/materialization; public capability requests and DTOs never select an implementation or carry raw readings. Native diagnosticSourceReader is independent of Node callback caps and is staged only for a boundedSource Policy; metadataOnly/none runs omit it. Raw source/readers never belong in persisted process DTOs or ordinary logs.
- `native-diagnostic-source-reader-installation.mjs` is the single exact private reader-selector validator and Policy selection owner reused by installation parsing, admission, preparation and staging. `capability-runtime-admission-support.mjs` rechecks the persisted Native Policy digest before preparation; never turn a Node callback/capability into Native installation authority.
- `native-diagnostic-audit-installation.mjs` owns the separate exact `{maxBytes}` audit selection. Only a Native boundedSource run with its selected reader receives it. Service derives a generation-private audit path; the existing Rust synchronized writer owns records and fail-closed source copying. Metadata-only/none runs stage no writer. Native test must reload final Host configuration to prepare the writer even without ordinary plugins. Watch retains it, restart chooses a new file, and public DTOs never export its path or records.
- Native Observer support metadata is the pure `adapters/desktop/v8-host/bootstrap/native-observer-platform.mjs` leaf, shared with Native Host registration. Service may read that descriptor, not import/start the Host controller. `capability-runtime-observers.mjs` owns target-specific Policy validation. Inline callbacks belong to Host plugins; Node callback IDs never become Native authority.
- `native-observer-profiles.mjs` owns the strict owner-private `native-observer-profiles.json` reader, immutable source/registration/sink-limit registry and canonical versions. Source collection reuses the Native reader and bundle collector; an injected reader retains the caller's role ledger and ownership. Native `initialObserverIds` selects only that registry. Admission privately pins versions; prepare repeats Policy/support/version checks. `native-observer-materialization.mjs` stages selected modules and generation-owned bounded output separately from ordinary Cordis plugins. Watch never changes profiles. Public DTOs contain neither these private bindings nor an event-export endpoint; old inline closures remain non-isolated.
- `native-launch-materialization.mjs` owns exact logical graph admission and private generation layout; Rust `SourceStore` separately enforces the private launch's exact URL allowlist. `native-output-pool.mjs` bounds adapter staging while the existing log store owns durable output. `process-removal-cleanup.mjs` journals deferred Native root cleanup in the existing state transaction; startup/maintenance may retry only absent-owner tickets.
- Native-only public `moduleAliases` maps requested virtual URLs directly to present canonical source rows. Admission rejects chains, collisions, identity-suffix changes and quota overflow, freezes the map before staging, and includes it in the graph digest. Staging writes canonical files only; private v3 carries the aliases and union allowlist. Node/Android never consume this extension.
- Native Guest rows may carry only `metadataOnly:true` on exact queryless `package.json`; physical/alias conflicts and restricted entries reject. The unchanged bytes plus a locale-independent tagged digest bind a private v4 `moduleMetadataOnly` list. Empty lists retain old digest/launch versions. This is a Guest read restriction, not a Host Bundle V2 row extension or a public diagnostic field. The CLI reserves its selected Service home through the Native source reader before owner capture and Guest collection.
- `native-plugin-materialization.mjs` owns bounded immutable Native Bundle staging and atomic Host config replacement. The adapter advances plugin revision only after its private FD 3 acknowledgement; ambiguous outcomes stop the generation and retain unreaped cleanup ownership. Internal Service observation is unreferenced, unlike explicit standalone watch.
- Native V2 plugin graphs stage original canonical bytes under `sources` and a strict adjacent `source-graph.json`; aliases never become copied modules, generated links or a synthetic package scope. The sourceGraph locator remains private Host configuration. `runtime-plugin-schema.mjs` is the common OpenAPI/Ajv shape owner; start and update registries reject V2 on Node/Android before dispatch. Do not turn an unaccepted metadata-role case into a permission fallback.
- Staged V1 Host plugin packages declare `type: module`: the contract is self-contained ESM, and `.js` entry/internal modules must not silently become CommonJS. Keep original file bytes and bundle digests; missing nested `package.json` probes must return not-found so the shared loader can reach this package scope.
- `capability-process-backends.mjs`, `capability-process-profiles.mjs`, and `capability-runtime-admission.mjs`: read the owner-only Host
  Backend installation and Process profile manifests, then admit only an installed Backend whose descriptor matches the target;
  no Backend path or configuration enters public DTOs.
- `inspector-proxy.mjs`, `cdp-*.mjs`: process-scoped external CDP proxy.
- `native-inspector-transport.mjs`: one bounded Native Unix connection per generation, with lease-local ID remapping; only the actual Native Runtime owns its executable-command Gate. Native resume enters the existing Service lifecycle before upstream I/O and acknowledges only after completion. `process-resume-registry.mjs` atomically fences superseded resume completions; uncertain Native acknowledgements stop the owned generation or retain cleanup-pending ownership. WebSocket session close is idempotent and has bounded noncooperative-peer cleanup.

The CDP Network projection emits base and ExtraInfo events from the same redacted Fetch diagnostic,
uses generation-bound loader IDs, and retains only bounded request/timing/body state. It may expose an
IP literal already present in an authorized real request URL, but must not invent browser headers,
cookies, cache/service-worker behavior, remote addresses, TLS details, or native timing. Mock responses
use the explicit `holonomy-mock` protocol and never claim a socket or secure transport.

Keep Java/Kotlin unaware of CLI commands, test reporting, and OpenAPI. Android owns Bridge/environment,
runtime process execution, and native providers; this service owns orchestration, forwarding, cleanup,
and persistence. Network diagnostics are lossy side-channel data and must never influence Fetch.
Canonical process subresources use `/inspector-leases` and `/network/rules`; old route spellings are
compatibility-only and must not re-enter OpenAPI or CLI output.

## Verification

Run `pnpm vitest run --config tools/service/vitest.config.mjs --no-cache`, then ESLint and the repository
typecheck. Tests use injected adapters and temporary `HOLONOMY_HOME` directories; emulator integration
belongs to the top-level CLI E2E gate.

Native public recovery cases select a real binary with `HOLONOMY_NATIVE_TEST_EXECUTABLE` and own a private Service home, not a shared daemon. `__tests__/native-inflight-http-fixture.mjs` owns transport-admission and actual socket-close latches; its unit test and the Native in-flight/recovery journeys verify different layers. Keep actual child `close`, quota reuse and fresh-generation completion distinct from a genuinely injected late Host terminal; closing an old socket is not evidence of the latter.
