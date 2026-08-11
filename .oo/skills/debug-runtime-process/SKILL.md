---
name: debug-runtime-process
description: Debug one generation of a managed Holonomy Runtime through its Inspector lease and CDP proxy. Use when an agent must inspect sources, evaluate code, pause or resume startup, collect console output, or observe Holonomy Fetch requests in the Network domain.
---

# Debug Runtime Process

1. Read the process and record its current generation. The process must have started with Inspector mode `enabled` or `break`.
2. Create a lease with `POST /v1/processes/{id}/inspector-leases`, an `Idempotency-Key`, and `expectedGeneration`.
3. Wait for the returned operation to succeed, then read the Inspector resource. Use only its public `devtoolsFrontendUrl` or `webSocketDebuggerUrl`.
4. For raw CDP, enable `Runtime`, `Debugger`, and `Network` as needed. Use `Runtime.runIfWaitingForDebugger` only for a process in `waiting_for_debugger`.
5. Expect user sources under their original absolute URLs and internal sources under `holonomy:///runtime/`.
6. Treat Network diagnostics as bounded debug evidence. Sensitive headers and query values are redacted; unavailable response bodies must not be interpreted as failed Fetch calls.
7. Close the lease when finished. If the process generation changes, discard the old lease and create a new one.

Read [references/cdp-api.md](./references/cdp-api.md) for supported CDP Network methods and lifecycle details.
