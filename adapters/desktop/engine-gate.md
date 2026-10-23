# Controlled string generation

[简体中文](engine-gate.zh-Hans.md) · [Native desktop](README.md)

Native `holo` can authorize `eval` and the Function/AsyncFunction/GeneratorFunction/AsyncGeneratorFunction constructors through a Host Cordis plugin. V8 keeps the original source and Context, so direct eval retains lexical bindings. This is not global code-generation enablement.

For the Service-backed `holonomy run/test --target native` entry, see [Managed Native Engine Gates](managed-engine-gates.md), including its optional owner-private source-reader installation. It uses the same Native Gate, not a Service-side Node callback; separate diagnostic installations remain distinct.

Both the Policy ceiling and an explicit Host decision are required. A minimal `host.json`:

```json
{
  "schemaVersion": 1,
  "sandboxPolicy": {
    "schemaVersion": 2,
    "codeGeneration": {
      "strings": {
        "access": "controlled",
        "maxSourceBytes": 4096,
        "maxOperations": 16,
        "decisionTimeoutMs": 250
      },
      "wasm": { "access": "none" },
      "dynamicImport": { "access": "none" }
    }
  },
  "plugins": [{
    "id": "source-gate",
    "use": "./gate.mjs",
    "config": {
      "approved": [
        "5ea4202659491c599e6e629625e9ee9baad51ddeb6b8e38e7b500dce13a96d44"
      ]
    }
  }]
}
```

`gate.mjs` approves only the exact UTF-8 source `40+2`:

```js
export default (ctx, config) => {
  ctx.holo.engineGate(async request => {
    if (
      !request.signal.aborted && config.approved.includes(request.sourceSha256)
    ) return { action: 'allow' }
    return { action: 'deny', reasonCode: 'host.not_approved' }
  })
}
```

Put `console.log(eval('40+2'))` in `index.mjs`, then run `holo --host-config ./host.json ./index.mjs`. Expected output: `42`.

## Middleware and boundaries

- `ctx.holo.engineGate((request, next) => decision)` returns a disposable registration. The handler may return a decision or Promise. Use `await next()` for an outer audit/check wrapper; a leaf must explicitly allow. The terminal default is deny. Deny cannot be recovered by an outer allow, and duplicate `next()` is a denial even if the plugin catches the error.
- The request contains frozen Engine Gate metadata and an AbortSignal. Source bytes/digest are authoritative; callsite, origin and eval/Function entry detail are unavailable and must not be guessed. A bounded Host-only reader can be selected for source-bearing string, Wasm and dynamic module requests as described below.
- Policy deny, source-byte limits and operation limits execute before plugin middleware. Changing plugins cannot widen the frozen Policy. Setting only `access: controlled` still denies when no handler approves.
- Guest waits on a native channel while Host async work progresses independently. At deadline, compilation is denied and the signal is aborted. Late allow/rejection is observed but cannot compile. If Host fails to acknowledge cancellation within a further 100 ms, the watchdog terminates the failed Runtime generation.
- A prompt decision and a completed middleware chain are separate. Every started frame retains its graph lease until it settles, including an unawaited `next()`. A handler ignoring abort and never settling pins capacity and old graph drain; it is not magically killed as a Promise. Stop/restart the Runtime to recover that uncooperative plugin.
- Capability and Gate scopes share the same plugin revision. Watch replacement can serve new calls while old calls drain against their original immutable graph. Each scope has at most 32 handlers, each chain at most 128 handlers, and at most 32 leased Gate calls per Runtime.
- Sources must have an exact UTF-8 representation: raw lone-surrogate UTF-16 source is rejected to prevent digest collisions. ASCII `\uXXXX` escapes remain supported. Source replacement is never permitted.

## Bounded source reader

An owner may add `diagnosticSourceReader: {"capabilityName":"host.diagnostics.source.read","maxReadBytes":65536,"maxReads":8}` to `host.json` and select `sandboxPolicy.diagnostics.sourceReader: "boundedSource"` with a positive `maxSourceReadBytes`. The Policy diagnostics object must also include its other required fields. Startup rejects a bounded Policy without this explicit capability selection, or a selection without the bounded Policy. `metadataOnly` keeps the reader absent.

For a source-bearing Gate request, `request.sourceReader?.read({maxBytes: 64})` returns an independent byte copy to the Host plugin. Strings and file-backed dynamic modules use exact UTF-8 bytes; Wasm uses the verified binary BufferSource, including zero bytes. Synthetic modules report source unavailable and have no reader. The byte cap is the smallest of Policy, selected capability and the native 64 KiB hard cap; `maxReads` applies across all three kinds in the Runtime. A prefix may end within a UTF-8 character. The full source byte count and digest remain in metadata, while the prefix travels only through a private Host transport field.

The reader is one-shot and valid only during its decision. Invalid options, reuse, timeout, cancellation and close reject with `engine_source_reader_unavailable`. Returned copies are cleared best effort when the decision ends or is canceled, so plugins should consume them before returning. Rust-held raw prefixes are zeroized; V8-managed copies cannot be guaranteed erased. No source enters Guest, ordinary logs or Gate metadata. The optional durable audit below and experimental [Inspector](inspector.md) are separate installations; in-process restart evidence remains outstanding.

### Optional durable read audit

Add `"diagnosticAudit": {"path":"./private/audit.jsonl","maxBytes":1048576}` to the Host configuration. The parent directory must already exist, belong to the current user and have no group/other permissions (for example, mode `0700`). Relative paths are resolved from the Host config, never Guest cwd. The file is owner-private, regular, single-linked, no-follow and exclusively locked for the generation; a second Runtime must select another file. `maxBytes` is an integer from 1,024 through 16,777,216. Unknown fields are rejected.

Before returning a source copy, Rust appends and syncs one bounded JSONL record: `schemaVersion:1`, `event:"source.read.admitted"`, random `sessionId`, per-session `sequence`, `generation:1`, wall-clock `observedAt` in Unix milliseconds, and `request` containing only `requestId`, `codeKind`, `sourceSha256`, `sourceBytes`, `readBytes`. There is no source text, prefix, URL, callsite, plugin configuration or native path. The event records admission to copy, not proof that a plugin consumed the copy. The file itself is excluded from Guest source loading, including aliases. Explicit FS grants must also keep this directory private.

Existing history is validated under the exclusive lock with per-record and total byte limits; malformed records or an incomplete tail prevent startup without modifying that history. When selected, append/sync failure, an invalid file identity or the byte ceiling permanently disables further reads for that generation; no new source copy is returned. There is no truncation, automatic rotation or hidden stderr fallback. Restart with a new owner-selected file to resume after capacity is exhausted; the Host owns retention/export. Without `diagnosticAudit`, no durable read-audit guarantee is advertised. This sink covers Engine source readers (strings, Wasm and modules), not Network body readers or a complete product audit service.

## Controlled WebAssembly

The same Host plugin can authorize `runtime.code.generate.wasm`. Configure `codeGeneration.wasm` with `access: controlled`, `maxSourceBytes`, `maxOperations` and `decisionTimeoutMs`; the string policy is independent. A plugin should check the operation and approve the exact binary `sourceSha256`, not a source-text digest.

Supported entrypoints are `new WebAssembly.Module(bytes)`, `WebAssembly.compile(bytes)`, `WebAssembly.instantiate(bytes, imports)`, `WebAssembly.compileStreaming(response)` and `WebAssembly.instantiateStreaming(response, imports)`. Async entrypoints return Promises, including rejection paths. Instantiating an already admitted Module does not compile new code or spend another compilation operation.

Rust stages a bounded internal-slot copy of the BufferSource and rechecks its exact bytes before consuming one generation/request/deadline-bound admission. The V8 callback's placeholder string is never used as binary source. Proxy, shared, resizable and detached buffers are rejected without Guest getters or Proxy traps. The hard pre-copy limit is 16 MiB; Policy may lower it. Timeout and late-result fencing use the same Gate as strings.

Async compilation/instantiation retains a native liveness ticket through import binding and Promise settlement, including calls not awaited by entry. At most 32 operations may remain pending, each bounded by 120 seconds and the earlier Runtime deadline. A rejected/throwing operation releases its ticket; generic unresolved-Promise checks remain enabled for unrelated code.

Streaming entrypoints accept only a genuine Runtime `Response` or `Promise<Response>` with a successful status and `Content-Type: application/wasm`. Plain objects, Proxies and forged `Response.fromNetwork` values are rejected. The shared Response reads bytes under `min(network body limit, 16 MiB)`, then uses the same Rust staging and V8 Wasm callback; each compilation consumes one Wasm Gate decision. A `fetch()` Response remains subject to the selected Network Policy, Provider and Response continuation authorization. Response/Fetch is absent when Network is disabled. MIME, status, body-read and network cancellation errors reject the Promise; Runtime close or deadline terminates pending work. This API buffers the body before compilation rather than compiling incrementally. It is not v86 integration or a complete WebAssembly compatibility claim.

The MIME check uses the Response's current Headers, including valid changes made through its Headers API. Changing that header does not grant compilation: the Wasm Gate still authorizes the exact body digest.

## Controlled dynamic import

With Host configuration, `codeGeneration.dynamicImport` defaults to deny. Configure it as `controlled` with the same byte/count/deadline fields and explicitly approve `runtime.module.import` in `ctx.holo.engineGate` to enable it. Each dynamic call, including a cache hit, receives a decision before target compilation/evaluation. Static dependencies remain part of the verified module plan, not separate dynamic calls; nested dynamic imports receive their own decisions.

Module metadata has `codeKind: module`, exact `origin` equal to the canonical target URL, and `entryDetail: {kind: dynamicImport, source: loader}`. Callsite is unavailable. File-backed targets have the exact UTF-8 byte count/hash; engine-provided synthetic modules report source unavailable rather than inventing a source hash. The same frozen Policy limits, registry revision leases, timeout and late-result rules apply. Gate waiting is asynchronous: Guest timers continue and unawaited imports retain native liveness.

Module planning runs in a private Context using the shared resolver and descriptor-confined source store. Guest `Object`/`Array` prototype edits cannot change plan serialization or source identity. Parent identity comes from private V8 host-defined options, not `sourceURL` text. No planner object, Error prototype or function is exposed to Guest. There are at most 128 pending native imports, including items temporarily removed from the queue during nested evaluation; the existing Gate limit is separately 32. Imports with unavailable parent provenance fail closed.

Without Host configuration, ordinary imports remain confined to the entry root as before. With Host configuration, no plugin approval means deny. This does not expand permitted URL schemes or install arbitrary npm/native modules.

Partial Observer events are described in [Host configuration](host-configuration.md); the separate experimental [Native Inspector](inspector.md) also uses this Gate. Existing compiled functions/Modules are not retroactively revoked by plugin replacement; this Gate controls code generation/loading, not every later invocation. Current evidence is macOS arm64, not a complete M4 or cross-platform compatibility claim.
