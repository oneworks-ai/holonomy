# Mock network requests

[简体中文](../../guides/mock-network-requests.md)

Network Mock is process-scoped, declarative, and revisioned. It never executes scripts, regular expressions, templates, files, or shell commands.

## Install before entry

```sh
pnpm holonomy run examples/debuggable.mjs \
  --target node \
  --sandbox ./sandbox.json \
  --network-rules ./rules.json
```

Initial rules are installed atomically before entry evaluation.

## Replace while running

Send the complete set to `PUT /v1/processes/{id}/network/rules` with `Idempotency-Key`, current `expectedGeneration`, and current `If-Match` revision.

A new revision affects newly admitted exchanges; in-flight requests retain the previous snapshot. Resolve conflicts by rereading the resource instead of overwriting another client.

## Verify

Verify method, canonical URL, response status, `real` or `mock` source, terminal event, and bounded response body through logs or an Inspector Network lease.

See [Network Rule Schema](../reference/network-rule-schema.md).
