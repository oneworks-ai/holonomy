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
- `device-watcher.mjs`, `process-reconciler.mjs`: daemon-owned discovery and crash cleanup fencing.
- `android-emulator-*.mjs`: daemon-owned AVD identity, start/stop/restart, and crash recovery.
- `mutation-coordinator.mjs`: durable idempotency for direct side-effecting mutations.
- `*-target-adapter.mjs`: Node and Android execution adapters.
- `inspector-proxy.mjs`, `cdp-*.mjs`: process-scoped external CDP proxy.

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
