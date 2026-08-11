---
name: manage-runtime-process
description: Create, observe, stop, restart, and remove one managed Holonomy Runtime process through the Service OpenAPI. Use when an agent must run JavaScript on Node or Android, follow logs, preserve generation safety, or clean up only the process it created.
---

# Manage Runtime Process

Use only the Holonomy Service OpenAPI. Never construct ADB commands, device-private paths, CDP sockets, or Bridge identifiers.

1. Read `/healthz` and `/openapi.json`, then authenticate with the Service Token.
2. Refresh and list devices. Select one explicit online device whose platform matches the requested target.
3. Create the process with `POST /v1/processes`, an `Idempotency-Key`, an immutable launch snapshot, and `isolation: runtime`.
4. Record the returned `processId`, `generation`, and operation id. Poll the operation or resume `/v1/events` until the process is running, waiting for debugger, or terminal.
5. Read bounded logs with `/v1/processes/{id}/logs?after=<cursor>`. Advance the cursor only after receiving a page.
6. For stop or restart, send the last observed `expectedGeneration`. On 409, re-read the process instead of retrying against a newer generation.
7. Restart keeps the process id and increments generation. Treat every prior Inspector lease, event stream, and pending action as stale.
8. Remove only a terminal process created by this workflow. Do not drain the Service or remove another client’s resources.

Read [references/process-api.md](./references/process-api.md) for request shapes and state rules.
