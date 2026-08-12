# Manage Runtime processes

[简体中文](../../guides/manage-processes.md)

Holonomy uses a stable `processId` for one logical process. Restart preserves the id, increments `generation`, and creates a fresh Runtime, NativeHost, and Inspector context.

## Create

A foreground run waits for a terminal state:

```sh
pnpm holonomy run examples/basic.mjs --target node
```

A detached run returns the process id immediately:

```sh
pnpm holonomy run examples/basic.mjs --target node --detach
```

## Observe

```sh
pnpm holonomy process list
pnpm holonomy process show <process-id>
pnpm holonomy process logs <process-id> --follow
```

Logs and terminal records are retained for 24 hours by default. OpenAPI clients advance the returned log or SSE cursor; array length is not a cursor.

## Stop and restart

```sh
pnpm holonomy process stop <process-id>
pnpm holonomy process restart <process-id>
```

OpenAPI mutations include the last observed `expectedGeneration`. On 409, read the process again instead of retrying the old intent against a newer generation.

## Remove

```sh
pnpm holonomy process remove <process-id>
```

Remove accepts terminal processes and cleans their logs, Network Rules, Inspector leases, and retained fixture lease. A normal Service stop rejects active owned resources; only explicit `--drain` cleans resources owned by that Service.

See [Process and Generation](../concepts/process-and-generation.md).
