# Service Native source-read audit

[简体中文](managed-source-audit.zh-Hans.md) · [Source reader](managed-engine-gates.md#optional-host-only-source-reading)

The Service owner can require bounded, synchronized metadata records before its Native Engine source reader returns a source copy. This reuses the standalone Rust audit writer; it does not log source text, grant reading permission or configure Observer output.

## Owner installation

Use an isolated `HOLONOMY_HOME` as in [managed Gate setup](managed-engine-gates.md#setup). In its owner-only `native-runtime.json`, select both the reader and audit:

```json
{
  "schemaVersion": 1,
  "executablePath": "/absolute/owner-selected/holo",
  "diagnosticSourceReader": {
    "capabilityName": "host.diagnostics.source.read",
    "maxReadBytes": 65536,
    "maxReads": 8
  },
  "diagnosticAudit": { "maxBytes": 1048576 }
}
```

The file must be a bounded owner-only regular file without a symlink leaf. `diagnosticAudit` accepts only required `maxBytes`, an integer from 1024 through 16777216. Omission means no audit installation; `null`, unknown fields and paths are invalid. The Service derives the output location. Installation is frozen at Service startup; edits require owner restart, not a plugin watch update.

Audit selection alone cannot install a reader. A Runtime must independently obtain the existing `boundedSource` Policy and Native reader selection. `metadataOnly` and `none` runs stage no audit writer/file even when audit is installed. Node and Android do not consume this Native installation.

## Minimal real read

Create `runtime.json` in the project:

```json
{
  "schemaVersion": 1,
  "context": { "schemaVersion": 1 },
  "initialMiddlewareId": "service.continue.v1",
  "sandboxPolicy": {
    "schemaVersion": 2,
    "codeGeneration": {
      "strings": {
        "access": "controlled",
        "maxSourceBytes": 4096,
        "maxOperations": 8,
        "decisionTimeoutMs": 1000
      },
      "wasm": { "access": "none" },
      "dynamicImport": { "access": "none" }
    },
    "diagnostics": {
      "sourceReader": "boundedSource",
      "maxSourceReadBytes": 4096,
      "observerEvents": [],
      "maxQueuedEvents": 0,
      "maxObserverCallbackMs": 1,
      "retentionMs": 0
    }
  }
}
```

Create `gate.mjs`:

```js
export default ctx => {
  ctx.holo.engineGate(async request => {
    if (request.operation !== 'runtime.code.generate.strings') {
      return { action: 'deny', reasonCode: 'example.unexpected_operation' }
    }
    const bytes = await request.sourceReader.read({ maxBytes: 4 })
    return bytes.length === 4 && bytes[0] === 52 && bytes[1] === 48 &&
        bytes[2] === 43 && bytes[3] === 50
      ? { action: 'allow' }
      : { action: 'deny', reasonCode: 'example.unexpected_source' }
  })
}
```

Create `holo.config.json`:

```json
{ "plugins": [{ "id": "gate", "use": "./gate.mjs" }] }
```

Create `index.mjs`:

```js
// eslint-disable-next-line no-eval -- Explicitly exercise the controlled Native Engine source reader.
console.log(eval('40+2'))
```

```sh
holonomy run ./index.mjs --target native --capability-runtime ./runtime.json --config ./holo.config.json --detach
```

The command returns a process ID; its Guest output is `42`. The Host reader consumes the prefix before returning its Gate decision and never prints it. The same static installation is available with `holonomy test`; tests do not enable plugin watch.

## Private record and lifecycle

With the default state layout, the Host owner reads:

```text
HOLONOMY_HOME/state/native-processes/<processId>/g<generation>/host/audit/source-reads.jsonl
```

This is not a public endpoint, DTO field or Guest path. The private directory/file use modes `0700`/`0600`; Rust checks the opened descriptor, single-link identity and exclusive lock. A custom state directory changes the prefix. Explicit Host FS grants must keep it private.

Records use the existing [durable read-audit schema and failure rules](engine-gate.md#optional-durable-read-audit): `source.read.admitted`, random session, sequence, local Runtime `generation:1`, timestamp, and request ID/kind/source hash/byte counts only. The outer Service generation is represented by its directory, not by rewriting Rust records. Each append is synchronized before the source copy is returned; this records admission to copy, not proof that the plugin consumed it.

Capacity, identity or append/sync failure permanently disables further source reads in that generation before another source copy is returned. There is no truncation, rotation or stderr fallback. It does not silently allow the Gate: the trusted handler still owns its decision. Ordinary plugin watch cannot replace audit configuration. Restart gets a new generation file/session; process removal cleans owned files, so save required records first.

Stop a still-running example with `holonomy process stop <process-id>`, remove its terminal resource with `holonomy process remove <process-id>`, then stop only this isolated Service using `holonomy service stop --drain`. Do not drain a shared Service.

Without audit installation, the existing source reader remains usable but has no durable audit guarantee. This covers Engine source readers, not Network body inspection, a complete audit service or arbitrary inline Observer callbacks. Native execution remains Rust/V8 and Node-free; the external CLI/Service may use Node. Current execution coverage is macOS arm64, not production release or all-platform acceptance.
