# Holonomy Service

[简体中文](./README.zh-Hans.md)

Holonomy Service is the persistent, machine-level control plane used by the Holonomy CLI. It owns
device inventory, runtime-process lifecycle, logs/events, network-rule generations, inspector leases,
and the authenticated OpenAPI surface. A CLI process connects to the daemon; it does not host Android
or Node runtimes itself.

## Library entry points

```js
import {
  createHolonomyServiceClient,
  ensureHolonomyServiceProcess
} from './tools/service/index.mjs'

await ensureHolonomyServiceProcess({ environment: process.env })
const service = createHolonomyServiceClient({ environment: process.env })

const admitted = await service.launchProcess(snapshot, crypto.randomUUID())
const processId = admitted.value.process.id
await service.readLogs(processId, { after: 0, waitMs: 1_000 })
await service.processAction(processId, 'restart', 1, crypto.randomUUID())
await service.processAction(processId, 'resume', 2, crypto.randomUUID())
await service.processAction(processId, 'stop', 2, crypto.randomUUID())
await service.removeProcess(processId, 2, crypto.randomUUID())
await service.openInspector(processId, 2, crypto.randomUUID())
await service.replaceNetworkRules(
  processId,
  rules,
  currentRevision,
  crypto.randomUUID()
)
```

`ensureHolonomyServiceProcess()` starts `entry.mjs` as a detached process, then waits for its health
endpoint. Local state lives below `HOLONOMY_HOME` (default `~/.holonomy`) with separate endpoint,
token, state, and journal artifacts. The token and ownership files are mode `0600`; directories are
mode `0700`.

Native is opt-in. The Service owner places `native-runtime.json` under `HOLONOMY_HOME`, mode
`0600`, with `{"schemaVersion":1,"executablePath":"/absolute/owner-selected/holo"}`. The
executable must be an owner-owned, regular, executable file without a symlink or group/world write
permission. Its canonical ancestors must also be trusted; a writable untrusted ancestor is rejected.
The same owner-only file may explicitly install `diagnosticSourceReader`; per-run `boundedSource` Policy is separately required. Default `metadataOnly`/`none` runs remain reader-free, and Node callback settings cannot authorize Native reads. See [Managed Native Engine Gates](../../adapters/desktop/managed-engine-gates.md#optional-host-only-source-reading) for the exact configuration and limits. Reader bindings and raw source are private, not public process state.
The separate optional `diagnosticAudit: {maxBytes}` installation [synchronizes bounded metadata before Native source copying](../../adapters/desktop/managed-source-audit.md). It never grants reading authority. Only a selected boundedSource run receives a Service-derived generation-private sink; no public input path or event-export API is added.
Native [Observer plugins](../../adapters/desktop/observer.md) register through `ctx.holo.observe` under the actual Native support descriptor. Service Node callback IDs cannot install Native callbacks. This is partial Host-only metadata delivery, not an external telemetry sink or independent synchronous callback isolation.
For isolated execution, the owner may install [Native diagnostic profiles](../../adapters/desktop/managed-observer-profiles.md) in the separate `HOLONOMY_HOME/native-observer-profiles.json`. Native `initialObserverIds` selects only these immutable resources; it cannot submit modules, callbacks or output paths. Policy/support/version checks precede Guest entry; output remains private to each generation and is not a public event API. Node callback bindings remain separate.
The Native CLI also needs this local installation for source preflight, even when its target Service is remote; keep frontend and runtime builds compatible. Source preparation uses the binary's private source-only helper without starting V8 or executing plugins. It snapshots original Host/Guest roles before Service staging, retains a lease during CLI watch, and supports physical package metadata through the shared resolver. The Service sends its own private execution workspace, not the caller's original filesystem path. These checks do not turn arbitrary authenticated Host publication into untrusted Guest input; the owner still controls what it deliberately publishes.
`holonomy run ... --target native` and `holonomy test ... --target native` submit a frozen
`app://workspace/` module graph; the Service materializes its exact source bytes in a private
generation directory and invokes that Rust binary's private owner-EOF launch port. Exact logical URLs
are allowlisted before Native module reads. Host Policy, Context, and installed filesystem
roots stay outside the Guest source directory. Native Inspector leases support enabled/break modes through the actual Native Gate; see the [Native Inspector guide](../../adapters/desktop/inspector.md). Network Rules, fixtures,
and public environment fields currently reject at admission. If the Service dies,
its pipe closes and the Native generation cancels itself. Recovery observes only its recorded PID;
unknown or reused live PIDs remain cleanup-pending and are never killed by a recovery scan.

Native `run`/`test` accepts the same bounded `holo-plugins:///` Bundles as Node. CLI `--config` builds
them in the caller workspace; an optional package config Schema travels in the bundle digest and is
checked again by the Native Host. Live `run` plugin-array updates keep the Guest generation and use
expected generation/revision fencing. Registry revision advances only after a private Native applied
acknowledgement. Rejected candidates retain the old graph; an ambiguous timeout/EOF stops the generation,
retaining cleanup-pending state if it cannot be reaped. Graph staging is capped at 256 revisions and
256 MiB per generation. Internal observation does not keep a finite script alive; explicit CLI `--watch`
does. This is configuration watch, not arbitrary source-file HMR.

Native output staging is bounded to 2 MiB per record, 16 MiB globally and 8,192 events; reads return
at most 512 KiB of serialized data. A cursor gap emits a fixed dropped-output marker. Durable logs
remain owned by the existing ServiceLogStore. Removal and retention first release the exact generation;
full-root cleanup occurs only after its registry record is removed. A failed final cleanup retains a
ticket in the existing state journal for startup/maintenance retry, rather than losing ownership.

An explicit remote endpoint never auto-starts or falls back to a local daemon:

```js
const remote = createHolonomyServiceClient({
  openapiUrl: 'https://runtime-host.example/openapi.json',
  tokenFile: '/absolute/path/holonomy.token'
})
```

The equivalent environment variables are `HOLONOMY_OPENAPI_URL`, `HOLONOMY_OPENAPI_TOKEN_FILE`, and
`HOLONOMY_OPENAPI_TOKEN`. Non-loopback service endpoints require TLS and exact configured Host
admission. CORS is not enabled.

The service publishes OpenAPI 3.1 at `/openapi.json`, global SSE at `/v1/events`, process SSE at
`/v1/processes/{id}/events`, and scenario skill resources at `/.oo/skills/index.json` and
`/.oo/skills/{scenario}/SKILL.md`. Inspector admission returns a process-scoped
`webSocketDebuggerUrl`; non-Network CDP passes through while the service maps bounded Fetch diagnostics
to the CDP Network domain. The projection includes request/response ExtraInfo, sanitized effective
headers, Fetch-layer timing, transfer sizes, response bodies within quota, and an explicit real/Mock
source. Mock responses never fabricate a remote address or TLS details; a real IP-literal target is
shown, while DNS/socket/TLS phase details remain absent until supplied by a trusted native transport.
Runtime stdout/stderr is retained in a bounded Service-owned log store for
24 hours; SSE publishes cursor-addressed `process.output` summaries so followers can resume without
duplicating the stored chunks.

The canonical process resources are `/v1/processes/{id}/inspector-leases` and
`/v1/processes/{id}/network/rules`. Every side-effecting mutation requires an `Idempotency-Key` and
is retained for 24 hours; `devices:refresh` is the explicit read-observation exception. Skill
references are served only from `/.oo/skills/{scenario}/references/{safe-name}.md` after regular-file,
realpath, symlink, and size checks.

Android control uses the app-private session-v2 ingress only for daemon wake-up, then discovers the
owner-private endpoint descriptor and owns its ADB forward. Node uses one `NodeRuntimeSupervisor` per
logical runtime process. A Node-only host remains usable when Android SDK/ADB is absent. Adapter
capacity, not the service registry, decides concurrency limits. Android `isolatedProcess` currently
fails with stable code `process.isolation_unsupported` instead of falling back to logical isolation.
The daemon can also start installed AVDs and records an owner nonce, launcher PID, AVD name, and serial;
the nonce is queried from the running emulator before stop/restart, so external emulators and physical
devices are never killed by the service. Persisted Android runtimes are stopped and disposed during
daemon recovery; offline devices remain fenced as lost until the device watcher can retry cleanup.
