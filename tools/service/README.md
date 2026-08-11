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
