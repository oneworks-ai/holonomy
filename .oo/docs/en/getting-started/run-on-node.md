# Run on Node

[简体中文](../../getting-started/run-on-node.md)

The Node target runs JavaScript without ambient host Node authority. Each Runtime gets an independent Node child process and a fresh `vm` Context.

## Prerequisites

```sh
pnpm install
pnpm build
```

## First program

```sh
pnpm holonomy run examples/basic.mjs --target node
```

`--target` is required. The CLI starts or reuses the current user's loopback Service, compiles a bounded module graph, waits for terminal state, and forwards stdout/stderr.

## Tests

```sh
pnpm holonomy test "conformance/specs/**/*.test.mjs" \
  --target node \
  --sandbox conformance/sandbox/restricted.json \
  --reporter json
```

Fetch conformance uses a Service-owned loopback fixture and no public internet endpoint.

## Detached process

```sh
pnpm holonomy run examples/basic.mjs --target node --detach
pnpm holonomy process list
```

Save the returned `processId`, then stop or remove it explicitly:

```sh
pnpm holonomy process stop <process-id>
pnpm holonomy process remove <process-id>
```

Next: [Managed processes](../guides/manage-processes.md) · [Node platform](../platforms/node/index.md)
