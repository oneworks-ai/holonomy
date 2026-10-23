# Managed Native Engine Gates

[简体中文](managed-engine-gates.zh-Hans.md) · [Engine Gate semantics](engine-gate.md)

The public `holonomy run/test --target native` path uses the installed Rust/V8 `holo` and its existing Host plugin Gate. The Service carries the frozen Policy and plugin Bundle; it does not make or serialize the Native allow decision. The external CLI/Service may use Node, but the selected Runtime does not.

## Setup

Use an isolated Service home for this example:

```sh
export HOLONOMY_HOME="$PWD/private/holo-service"
mkdir -p "$HOLONOMY_HOME"
chmod 700 "$HOLONOMY_HOME"
```

Create `$HOLONOMY_HOME/native-runtime.json`, then `chmod 600` that file:

```json
{ "schemaVersion": 1, "executablePath": "/absolute/path/to/holo" }
```

Use the CLI/Service and Native binary from the same compatible development build; an older frontend may still reject these options. Create `runtime.json` in the project directory:

```json
{
  "schemaVersion": 1,
  "context": {
    "schemaVersion": 1,
    "guest": {
      "application": { "id": "example.native-gates", "name": "Native Gates" }
    },
    "host": {},
    "inspector": {}
  },
  "initialMiddlewareId": "service.continue.v1",
  "sandboxPolicy": {
    "schemaVersion": 2,
    "codeGeneration": {
      "strings": { "access": "none" },
      "wasm": {
        "access": "controlled",
        "maxSourceBytes": 4096,
        "maxOperations": 8,
        "decisionTimeoutMs": 1000
      },
      "dynamicImport": {
        "access": "controlled",
        "maxSourceBytes": 4096,
        "maxOperations": 8,
        "decisionTimeoutMs": 1000
      }
    }
  }
}
```

Create `holo.config.json`:

```json
{ "plugins": [{ "id": "gate", "use": "./gate.mjs" }] }
```

Create `gate.mjs`. This example approves only the empty Wasm module's exact digest and the selected module URL; applications should additionally pin approved module digests:

```js
export default ctx => {
  ctx.holo.engineGate(request => {
    if (
      request.operation === 'runtime.code.generate.wasm' &&
      request.sourceSha256 ===
        '93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476'
    ) return { action: 'allow' }
    if (
      request.operation === 'runtime.module.import' &&
      request.origin === 'app://workspace/lazy.mjs'
    ) return { action: 'allow' }
    return { action: 'deny', reasonCode: 'example.not_approved' }
  })
}
```

Create `lazy.mjs` with `export const answer = 42`, and `gates.test.mjs`:

```js
import assert from 'node:assert/strict'
import { it } from 'node:test'

it('uses the Native Host Gate', async () => {
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
  assert.ok(await WebAssembly.compile(bytes) instanceof WebAssembly.Module)
  assert.equal((await import('./lazy.mjs')).answer, 42)
})
```

Run from that project directory:

```sh
holonomy test ./gates.test.mjs --target native --capability-runtime ./runtime.json --config ./holo.config.json --reporter json
```

Expected result: one passed Guest test. Static plugin installation is available to both `run` and `test`; `--watch` is still run-only. Every test starts with its admitted graph, not a graph changing mid-suite. Use `holonomy process list`, then remove only this example's terminal process with `holonomy process remove <id> --expected-generation 1`. Stop this isolated Service with `holonomy service stop` when done.

## Optional Host-only source reading

The Service owner can extend the same private `native-runtime.json` installation:

```json
{
  "schemaVersion": 1,
  "executablePath": "/absolute/path/to/holo",
  "diagnosticSourceReader": {
    "capabilityName": "host.diagnostics.source.read",
    "maxReadBytes": 65536,
    "maxReads": 8
  }
}
```

`maxReadBytes` is an integer from 1 through 1,048,576; `maxReads` is an integer from 1 through 1,024. Unknown fields, a wrong capability, invalid limits or an insecure installation file prevent startup. This owner-controlled installation is separate from a Node adapter's callback/capability settings and cannot be supplied in a public Runtime request. It is read when the Service starts; installation edits require the owner to restart that Service, not a plugin-config watch update.

To use it for a particular run, add this complete `diagnostics` object inside that run's `sandboxPolicy`:

```json
{
  "diagnostics": {
    "sourceReader": "boundedSource",
    "maxSourceReadBytes": 4096,
    "observerEvents": [],
    "maxQueuedEvents": 0,
    "maxObserverCallbackMs": 1,
    "retentionMs": 0
  }
}
```

This is a fragment to merge, not a complete Runtime configuration. An async handler in the Host Gate plugin can then consume `await request.sourceReader.read({maxBytes: 64})` before returning its decision. Never print the returned bytes. Strings, verified Wasm bytes and source-bearing planned modules use the same existing [reader lifetime and limits](engine-gate.md#bounded-source-reader); synthetic modules do not acquire source bytes.

Installation alone does not enable reading: `metadataOnly` or `none` runs omit the reader even when the Service has installed it. Conversely, `boundedSource` without the Native installation fails admission before Guest entry; a Node callback cannot satisfy it. The effective byte cap is `min(Policy, installation, 64 KiB)`; the installed read-count budget is shared across that Runtime's source-bearing Gate requests. Restart creates a new Runtime and budget, never a reusable old reader.

The Service stages the selected capability only in the generation's owner-private Host configuration. Reader objects and raw source prefixes do not enter public process DTOs, Gate metadata, Observer events or ordinary logs. A trusted plugin can deliberately publish bytes it reads, so plugin code remains trusted. The owner can separately install [durable source-read audit](managed-source-audit.md); the reader alone does not enable it or [Native Host-plugin Observer subscriptions](observer.md).

## Boundaries

- Policy `none`, byte/count limits and deadlines precede Host approval. `controlled` without an approving plugin still denies.
- The CLI captures a finite source closure before Service startup. A computed import cannot load a target absent from that closure; an approving Gate is not permission to read arbitrary files.
- The Native Gate retains authoritative source digests and HDO importer identity, cache-hit checks, timeout/late-result fencing and generation cleanup. No Service-side Node callback substitutes for the Native plugin.
- Bounded source reading requires the explicit Native installation above. [Durable audit](managed-source-audit.md) is an independent owner selection with Service-derived private paths, not a public event-export API. [Native Observer](observer.md) uses Host-plugin registration under its own Policy, not Service Node callback IDs. [Desktop Device](device.md) has its own independent installation and Policy; none of these options implicitly enables another.
- A development package verifies real Wasm execution plus Wasm/import allow-deny after extraction with an empty PATH. That smoke is not the complete M4, cross-platform or production-release acceptance.
