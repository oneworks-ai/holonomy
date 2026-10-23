# Native Inspector (experimental)

[简体中文](inspector.zh-Hans.md)

The standalone Rust `holo` exposes a real V8 Inspector session only with an explicit private Unix socket:

```sh
mkdir -m 700 ./private-inspector
holo --host-config ./host.json --inspector-socket /absolute/private-inspector/session.sock ./index.mjs
```

The parent must be owned by the current user with no group/other permissions. Ancestors must be trusted; the canonical parent is used for binding and cleanup. The socket is `0600`, and accepted peers must have the same UID. There is no TCP listener or discovery HTTP endpoint. One bounded newline-delimited CDP session is accepted per invocation; each incoming frame is at most 64 KiB and pending outgoing data at most 1 MiB/32 messages. The runtime deadline and owner cancellation still apply while paused.

The separately installed machine Service now exposes authenticated, generation-bound Native Inspector leases over this private transport. Its owner selects the executable in `HOLONOMY_HOME/native-runtime.json`, mode `0600`, using `{"schemaVersion":1,"executablePath":"/absolute/owner-selected/holo"}`. The executable and ancestors must be owner-controlled and not writable by untrusted users. Then use the control-plane CLI from that installation:

```sh
pnpm holonomy run ./index.mjs --target native --inspect-brk --detach
pnpm holonomy process inspect <process-id>
```

The control-plane CLI/Service still uses Node; Guest execution uses the standalone Rust binary. `--inspect` enables inspection without holding entry; `--inspect-brk` holds Guest evaluation until `Runtime.runIfWaitingForDebugger`. This is an entry barrier, not a V8 first-line breakpoint claim. Early resume may latch, but executable commands stay denied until Host initialization and module-plan installation finish. Deadlines and owner cancellation apply throughout setup, waiting and pause.

Leases share one Guest Inspector connection and debugger state per generation, while request IDs and lease closure remain separate. Closing one lease does not close another; restart invalidates old tokens and closes old WebSockets. Noncooperative clients are forcibly disconnected after a bounded grace. Native execution commands still use the actual Runtime Policy/Cordis Gate. An admitted resume remains Service-owned if the client disconnects, and success is acknowledged after lifecycle completion. An uncertain Native resume acknowledgement stops that generation or retains cleanup-pending ownership.

Full DevTools frontend compatibility and Native Network diagnostic projection are not claimed; the method allowlist below remains authoritative.

## Authorization

Read-only session/debugger controls are allowlisted. Executable commands require both the matching `sandboxPolicy.inspector` bit and `codeGeneration.strings.access: controlled`, followed by explicit approval from the Host Cordis Engine Gate. Policy permission alone is insufficient. See [Engine Gate](engine-gate.md) for the controlled string policy and plugin setup.

| CDP method                                         | Inspector Policy bit |
| -------------------------------------------------- | -------------------- |
| `Runtime.evaluate`, `Debugger.evaluateOnCallFrame` | `evaluate`           |
| `Runtime.compileScript`                            | `compileScript`      |
| `Runtime.runScript`                                | `runScript`          |
| `Runtime.callFunctionOn`                           | `callFunctionOn`     |

Unknown methods and conditional breakpoint injection are denied. `Debugger.setScriptSource` is routed through its Policy/Gate when requested, but the pinned V8 reports it unsupported; do not rely on live edit. The source reader, when separately selected, uses the same bounded Host-only byte channel as the other Gate paths.

Only the Guest Context is registered. Host worker and module-planner Contexts are not registered. Caller `sourceURL` is a V8 display label, never authoritative origin: Inspector Gate metadata reports origin unavailable. Reserved Host schemes cannot be used as display labels. Loader-derived module origins remain separate and authoritative. A Host plugin must not infer authority from arbitrary source text or labels.

## Current evidence and limits

Real Node-free binary tests cover session queries, Policy/Host denial, approved evaluation/compile/run/callFunction, pause/resume, source reading, early resume and untrusted-origin regressions. Service tests and a public CLI/HTTP/WebSocket smoke cover tokens, break/resume, two leases, restart and stale-connection closure. Socket EOF exits a pause loop; dispatch remains on the Guest engine thread. Current evidence is macOS arm64 only; full CDP, browser Network emulation and complete M4 acceptance remain unfinished.
