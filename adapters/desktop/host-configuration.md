# Native Host configuration

[简体中文](host-configuration.zh-Hans.md)

Pass `--host-config host.json` before the entry path. The Host supplies Policy and physical root installations; user JavaScript sees only virtual `holo-fs://` paths and the explicit Guest Context projection.

```json
{
  "schemaVersion": 1,
  "sandboxPolicy": {
    "schemaVersion": 2,
    "filesystem": {
      "access": "sandboxed",
      "roots": [
        {
          "rootId": "workspace",
          "virtualUrl": "holo-fs://workspace/",
          "rights": ["read", "write"],
          "symlinks": "deny"
        }
      ],
      "limits": {
        "maxReadBytes": 4096,
        "maxWriteBytes": 4096,
        "maxOpenHandles": 8,
        "maxWatchers": 0,
        "maxDirectoryEntries": 32,
        "maxQueuedEvents": 0
      }
    }
  },
  "filesystemRoots": [{ "rootId": "workspace", "hostPath": "./data" }],
  "context": { "schemaVersion": 1, "guest": { "application": "example" } }
}
```

Create the `data` directory first. Relative `hostPath` entries resolve from the configuration file's directory. Duplicate root IDs, unknown fields, unsupported versions and unavailable installations fail before user entry. Configurations are bounded to 1 MiB. The shared compiler supplies default-deny values for omitted Policy fields.

```js
import fs from 'node:fs'
fs.writeFileSync('holo-fs://workspace/result.txt', 'native Holonomy')
console.log(fs.readFileSync('holo-fs://workspace/result.txt', 'utf8'))
```

Run with `holo --host-config host.json ./index.mjs`. The `readFile`/`writeFile` sync, callback and Promise paths use the same Broker. Virtual fd and FileHandle resources are generation-owned; closing invalidates them. Read/write bounds apply before returning or writing bytes. `w` uses atomic replacement and `wx` refuses an existing target.

Optional `systemProjection` uses the shared `{schemaVersion:1, fields:{...}}` schema; corresponding `sandboxPolicy.systemInformation.fields` must allow each field's mode and precision. Host and Inspector Context projections remain private. An explicit macOS arm64 [Desktop Device installation](device.md) enables six required APIs under their independent Device Policy; default access remains denied. Inspector requires its separate private socket installation. Process remains default-denied: macOS can select the bounded [Native Darwin profile](process-native-darwin.md), or the experimental v86 installation below. Disabled or ungranted calls retain shared public errors.

With Host configuration, `process.env`, `pid` and `execPath` are admitted once after the initial Host plugins load and before Guest entry. Environment denial yields a frozen empty map. Denied `process.pid` and `process.execPath` accesses throw `ERR_ACCESS_DENIED` on the default/global object; their ESM named snapshots are `undefined`. Other authorized fields remain usable. `process.cwd()` is admitted on each call. `process.versions` describes Holonomy and V8 without claiming a Node version.

A Host may select `"processProfileId": "developer"` in `host.json` and pass `--process-profiles /absolute/private/process-profiles.json`. The separate manifest uses `{ "schemaVersion": 1, "profiles": { "developer": { ... } } }`, must be a regular owner-only file without a symlink leaf, and is protected from Guest module reads. A profile selection alone does not activate `host.process`; an uninstalled sandboxed Process policy still fails before entry.

An experimental v86 profile also requires `--process-backends /absolute/private/process-backends.json`. That separate owner-only manifest uses `{ "schemaVersion": 1, "backends": { "experimental.v86-v1": { "implementation": "builtin.v86-v1", "artifactRoot": "/absolute/verified-assets" } } }`. The selected Backend ID must match the profile; the root must be owner-controlled and free of a symlink alias. Rust still verifies each installed asset against the profile's digest before the VM can run. This configuration alone does not enable Process Policy.

The development-only `--experimental-v86-process` option adds a private Host activation bit after both manifests pass selection. It is still subject to SandboxPolicy, Process capability admission and Rust artifact checks. Real native Guest `spawn('cat')`, `execFile`, controlled shell, and FUSE Host read/write with process-attributed denial have passed. FUSE requires one `/workspace` mount, the installed `fuse` kernel capability, and both Process mount rights and ordinary FS Policy rights. Explicit restricted Process networking supports [bounded TCP/UDP, Host DNS and curl HTTP proxying](process-v86-network.md), without widening ordinary JS Fetch Policy. Scoped FUSE checks cover ACCESS, file/directory fsync, metadata, chmod and Git init/status; full POSIX/Git, TLS/address-family and descendant acceptance remain unfinished. The default CLI remains Process-denied, and this switch is not a broad support guarantee.

Rename requires the root's `move` right. Source and destination each undergo shared resource admission and bind a one-use identity ticket. Cross-root moves return `EXDEV`; replacing the source or a parent after admission rejects the commit.

Watch requires `watch` rights and positive `maxWatchers`/`maxQueuedEvents`. macOS kqueue observes opened targets and their direct children; bounded directory snapshots supply changed names. Recursive watching is not enabled. `fs/promises.watch()` synchronously returns an AsyncIterator; overflow terminates with `ENOSPC`, and Abort/close releases resources. `persistent:false` does not keep the process alive. OS notifications can coalesce, so one notification per write is not guaranteed. Deleting, renaming or revoking the watched target emits an error and closes it. Watch the parent directory when files may be atomically replaced.

The default `symlinks: deny` profile rejects symlinks, including write/unlink targets. Opt-in `symlinks: withinRoot` resolves bounded links under the same installed root, re-admits the resolved resource through Policy/Broker, and retains the exact admitted native descriptor. It never exposes a physical path to Guest code.

The withinRoot subset supports reads, stat, readdir, open/FileHandle and file/directory watch, plus bounded exclusive creation and writes through admitted handles. A watch subscribes to the admitted file or directory descriptor, so replacing a path or symlink after admission cannot redirect the watch to another inode. Existing writable files are opened without truncation until identity is checked. Missing targets use an admitted parent descriptor and exclusive creation, so a concurrently created leaf cannot be overwritten. Descriptor authority is an object capability: a later rename does not silently bind that handle to another inode.

WithinRoot lstat supports ordinary files and directories, including objects reached through an in-root parent-directory symlink. Final symlinks (in-root, external or broken) still return `provider.unavailable`; lstat neither follows them nor returns link-target metadata. It reads the verified pinned descriptor: identity changes before verification fail closed, while later pathname replacement still reads only the original object.

WithinRoot rename, unlink, atomic replacement of an existing target and recursive mkdir with multiple missing ancestors remain unsupported and fail closed. In particular, default atomic `writeFile` cannot replace an existing file in this profile; use an explicitly admitted writable FileHandle when appropriate. A file watch observes its original inode; deleting, renaming or revoking that inode ends the watch with an error and close, while an atomically replaced path needs a parent-directory watch. These restrictions do not remove support from the deny profile. At most 64 resolution tickets are retained; failed/cancelled admissions release their descriptors.

Reads/writes have an 8 MiB native ceiling and request JSON is bounded to 1 MiB. Watch also has Host ceilings of 1024 watchers and 4096 underlying vnode subscriptions.

The selected v86 profile may separately enable [Device/System domains](process-v86-capabilities.md) for `hoholo`. Domains alone grant nothing: Host Device installation, field Policy/projection and the same middleware still apply. These are one-shot reads, not a Linux event subscription or raw Host OS fallback.

## HTTP(S) and mocks

`sandboxPolicy.network` accepts the shared `none`, `mockOnly` and `restricted` forms. A restricted example to merge into `sandboxPolicy`:

```json
{
  "network": {
    "access": "restricted",
    "allowedOrigins": ["https://example.org"],
    "allowedSchemes": ["https"],
    "allowPrivateNetwork": false,
    "limits": {
      "maxUrlBytes": 4096,
      "maxHeaders": 32,
      "maxHeaderBytes": 16384,
      "maxRequestBodyBytes": 1048576,
      "maxResponseBodyBytes": 1048576,
      "maxChunkBytes": 65536,
      "maxConcurrentConnections": 4,
      "maxRedirects": 0,
      "socketTimeoutMs": 5000
    },
    "requestBodyInspection": { "access": "none" }
  }
}
```

Guest uses standard `fetch()`. Every redirect is re-admitted; zero redirects is valid. DNS checks the entire resolved set and pins the admitted addresses. Private networks require explicit permission. HTTPS verifies both the certificate and original hostname; optional top-level `networkTrustRoots` adds up to eight PEM certificates, each at most 64 KiB. It never disables TLS verification or uses ambient proxy settings.

Top-level `networkRules` supplies the existing Network Rules schema in the Host Context. `mockOnly` cannot fall through to real I/O. Abort cancels admission/preflight and transport; response size and timeout failures preserve their public Network errors. `fetch()` resolves when validated response headers arrive. Response bodies stream through the existing Bridge credits: each downstream credit permits one bounded upstream pull. Clones share one upstream; cancelling the final reader closes it and releases its connection slot. A cancelled or closed operation cannot publish an already queued head/chunk or resurrect a stream.

`socketTimeoutMs` bounds DNS/head work and each active body read, not the time a caller deliberately withholds credits. Request bodies are still staged before I/O; request/response bodies retain an 8 MiB native ceiling, and response chunks obey `maxChunkBytes`. An idle retained body does not by itself keep the Runtime alive. Request upload streaming, WebSocket and arbitrary TCP/UDP are not enabled on this native target.

### Host-only request-body inspection

Inspection is opt-in twice: set Network Policy `requestBodyInspection` to `{ "access": "bounded", "maxBytes": 4096, "maxReadsPerRuntime": 16 }`, then add top-level `networkRequestBodyReader: { "capabilityName": "host.network.request-body.read", "maxReadBytes": 4096, "maxReads": 16 }`. The Host selects that separate capability; the Kernel verifies its Policy/process/generation binding and applies all limits. Selection with a `none` Policy is invalid. Without selection, plugins see metadata only.

A trusted plugin can find `request.hostBindings?.find(binding => binding.kind === 'networkRequestBodyReader')` in its `network.fetch.request` interceptor. `await reader.read()` returns one independent byte copy; optional `{maxBytes}` returns a prefix. A second read fails. The reader is not a JSON argument, Provider continuation or Guest API. Raw bytes never enter serialized invocation metadata, Observer or ordinary diagnostics.

Without a selected reader, Guest hooks do not encode the extra inspection copy and Rust omits it before the owned Host queue. When enabled, Rust rechecks the frozen Host bound before copying and zeroizes its owned transfer strings on drop. V8's immutable strings and arbitrary copies made by trusted plugins cannot be guaranteed to be zeroized.

The entire body must fit the Policy/capability/1 MiB Host minimum. At most `min(maxReads, 64)` live readers and 1 MiB aggregate staged inspection bytes are retained; exhaustion omits the reader without denying ordinary Fetch. Copies can add at most another 1 MiB while live. Denial, cancellation, completion, restart or the request's `socketTimeoutMs` deadline revokes the reader and best-effort zeroes retained bytes/copies. This deadline also bounds a non-settling asynchronous inspection interceptor. Trusted plugins can intentionally retain other copies; zeroization is not a confidentiality boundary against Host plugin code.

## Initial Cordis plugins

Add `plugins` to the Host configuration. Each item has stable `id`, `use`, optional `config`, `enabled`, `export` (default `default`) and `integrity` (bundle SHA-256). Relative paths, including `../`, resolve from the configuration directory; package names resolve through its `node_modules` ancestry. Absolute paths additionally require a top-level `pluginRoots` allowlist. Packages must declare `holo: {kind: "runtime-plugin", apiVersion: 1, entry: "./index.mjs"}` in `package.json`.

```json
{
  "plugins": [{ "id": "deny-arch", "use": "./plugins/deny.mjs" }],
  "pluginRoots": ["./trusted-packages"]
}
```

An example `plugins/deny.mjs`:

```js
export default ctx => {
  ctx.holo.intercept(
    { operation: 'system.os.arch.read' },
    invocation => ctx.holo.deny(invocation),
    { execution: 'sync' }
  )
}
```

This plugin denies `node:os.arch()` if System Policy otherwise permits that operation. Policy remains the hard ceiling. Host plugins are trusted JavaScript extensions, not Guest programs; enable only trusted packages. Their complete immutable ESM graph is admitted under `holo-plugins:///` and installed with Cordis before Guest entry. Invalid imports, integrity failures or plugin setup errors prevent entry. Root device/inode identity is checked across the private child launch; symlink and root replacements fail closed.

This native slice supports bounded, fully snapshotted pure-JS ESM graphs, including relative dependencies, supported package `exports`/`imports`, and pnpm installations whose relative `node_modules` package links stay inside the configuration root. Package-directory and `package.json` entry paths also work; absolute sources require an explicit `pluginRoots` selection. Plain plugin entry package names do not accept subpaths. Physical ancestor packages retain strict nofollow lookup; linked packages outside the selected root, ordinary file symlinks, Node/native imports and unresolved external dependencies remain rejected. Build dependencies outside this subset into self-contained ESM output; this is not complete npm compatibility. `runtimePlugins`, `runtimePluginRoots` and `privateSources` are private launch fields and are rejected in public Host configuration.

The Native CLI pins one package-root descriptor for its manifest, Schema and internal modules; config watch retains the same source-role ledger. Requested package aliases and physical source identities remain private even after retargeting. Invalid Schema or Guest-to-Host promotion retains the last good graph. A source-reader session admits at most 128 package leases and 512 distinct package resources with 32 MiB total size high-water marks; unchanged rereads do not consume new resources. Config/token reads and all package leaf files remain nofollow. This is not source-file HMR or complete npm dependency resolution.

The Guest module reader excludes the actual Host configuration file and admitted Host plugin entries, explicitly selected manifests, schemas and code dependencies. Descriptor device/inode identity applies across hard links and URL aliases; changing `sourceURL` does not grant access. Ordinary Guest JSON modules and distinct Host/Guest files in one directory remain supported. Strongly private files cannot serve both domains, including a watch candidate that tries to use a previously read Guest module. All candidate graphs are prepared before any candidate plugin executes; a rejected update retains the old graph and the private identities already discovered.

A restricted exception is shared package-scope metadata: a local Host plugin and Guest `index.js` may use the same `package.json` through the trusted Loader for module type and package resolution. A file read only as Host package metadata does not become Guest-importable JSON; direct require/import, cache hits and alias requests still need separate source admission. Explicit private manifests, configuration and schemas do not qualify. Ordinary Guest `package.json` without a Host restriction retains its JSON behavior; original bytes are never rewritten or stripped of fields.

Before collecting Guest modules, the managed Native CLI reserves its complete selected Service home. State, configuration and control-plane files cannot become Guest modules even when that directory is inside the project; aliases through a renamed pinned directory are also checked. This does not automatically protect arbitrary OS directories, deliberately published Host data, or files exposed through explicit FS API grants.

Source admission retains file identities, logical private paths and pinned private directory entries for the Runtime lifetime, with a combined 4,096-record limit and at most that many retained descriptors. Guest lookup rejects known private paths before opening the file, including directory rebinding, and checks a pinned parent's private filename before the final descriptor-relative open. On macOS, names use conservative case-insensitive and canonical Unicode equivalence; on a case-sensitive volume this can also reject otherwise distinct case variants of a private name. Other Unix targets use byte-exact names and require case-sensitive filesystem lookup. Ordinary sibling files remain available. Private launch bindings are revalidated in the child; repeated replacements can exhaust the limit and require a restart.

The reader also observes the current objects at both logical private paths and pinned directory entries, protecting current hard links even after an external configuration directory is rebound. This observation is not an atomic filesystem transaction and is not the basis for rejecting a direct private pathname. It cannot freeze an external writer rotating unobserved objects or hard-link aliases during lookup. An external writer can otherwise publish previously unobserved secret bytes under a private name, move or copy them to a Guest name, then remove all current evidence before any Host observation. No POSIX inode check can reconstruct that history. Host publication must therefore keep unregistered temporary files, backups and moved/copied secrets out of Guest resource namespaces and serialize publication through new aliases; stronger arbitrary-writer information-flow isolation needs OS-level separation or controlled publication. Already registered private identities remain protected through renames and hard links. This boundary governs module loading only: an explicit Host filesystem grant can still expose those files through FS APIs, and the Host must avoid granting access to its secrets.

Packages may add `holo.configSchema: "./schema.json"`. The schema is snapshotted through the package root without following symlinks and validated before Guest entry or plugin publication. Native and Node use the same locked Ajv2020 validator with strict compilation, no format validation, coercion, unknown-key removal or default insertion. Boolean schemas and local `$defs`/`$ref` work; unresolved external references fail without network loading.

The native validator executes only in a disposable private `holo` helper, not in the live Host/Guest isolate. Schema files are at most 1 MiB and combined schema/config input at most 2 MiB. Validation uses a 750 ms deadline budget starting before helper spawn, a 32 MiB V8 heap and a macOS RSS monitor at 256 MiB. A blocked OS spawn is checked when it returns; expired results are rejected. This is not a whole-CLI startup-time guarantee. The RSS check is polled, not a kernel memory reservation. Timeout/crash/invalid configuration rejects the candidate; errors do not contain schema values or physical paths. Watch waits asynchronously so existing calls and Gate cancellation keep progressing; the last good graph remains active and later valid configuration can recover. These bounds may reject otherwise valid but excessively costly schemas.

## Plugin configuration watch

```sh
holo --watch --host-config ./holo.config.json ./index.mjs
```

`--watch` keeps this Runtime alive and observes the explicit Host configuration file. It is available for `run`, not `test`, and requires `--host-config`. It does not restart the Guest entry or provide arbitrary source-file HMR. Edit the `plugins` array to request a candidate; each changed candidate re-reads its complete module graphs, including relative dependencies. Editing only a source file does not trigger reload.

Plugin IDs are stable across replacements. Unchanged instances are retained; changed/removed instances are disposed through Cordis after their in-flight capability calls drain. Every module and dependency carries its bundle version, and dynamic import remains bound to its originating graph. A failed candidate leaves the previous graph active. Only one update is in flight; further config edits are reconciled afterward. Policy, root allowlists, projections, network rules and all non-plugin fields stay fixed for this Runtime and require a restart to change.

Authorize before calling `next()`, and return or await the delegated chain. A later denial cancels unfinished work but cannot undo I/O that already committed. Public completion is separate from chain settlement: unawaited descendants still retain their old graph and pending quota until all started work and cleanup finish. A stuck trusted plugin can therefore require stopping the generation; a prompt denial does not magically terminate its Promise.

Configuration checks are polled at 250 ms. Fixed, non-sensitive status messages appear on stderr. Ctrl-C or owner disconnection stops the Runtime; `--timeout` bounds its entire lifetime, including plugin startup and updates. Plugins remain trusted Host extensions: non-settling or synchronous blocking plugin code is not a separately preemptible sandbox.

## Engine Gate boundary

Real V8 string and Wasm callbacks reach `ctx.holo.engineGate` in the independent Host worker. Policy permission alone is insufficient: an explicit plugin decision is required. Original string source/Context are preserved and must encode exactly as UTF-8; Wasm uses a native BufferSource stage. Both have a 16 MiB pre-copy hard bound. Wasm streaming APIs accept genuine shared Responses, buffer them within limits, then enter the same native Gate; this is not incremental compilation. See [Engine Gate](engine-gate.md) for configuration, cancellation, the scoped Host-only string source reader and revision-drain behavior. Experimental standalone Inspector installation and limits are described in [Native Inspector](inspector.md).

For explicit source-reader audit, select the optional `diagnosticAudit` installation described in [Engine Gate](engine-gate.md#optional-durable-read-audit). It synchronizes bounded metadata before a source copy is returned and does not log source bytes or Network bodies. The private file and its retention are owned by the Host, not Guest or Observer plugins.

## Runtime Observer (partial)

See the paired [Observer guide](observer.md) for complete standalone and Service-backed examples, callback delivery limits and the remaining external-sink/isolation boundary.

Standalone owners may separately select experimental [isolated diagnostic profiles](observer-profiles.md) with private JSONL output. Their modules run in dedicated same-binary helper processes; existing inline callbacks below are not moved or given new isolation. Managed execution uses a separate owner-private [Service profile installation](managed-observer-profiles.md), not serialized Node callbacks.

Trusted Cordis plugins register `ctx.holo.observe({events: ['runtime.terminated'], maxQueuedEvents: 16, callbackTimeoutMs: 50}, event => { /* Host-only sink */ })`. Diagnostics Policy must allow every requested event. Native supports optional `script.compiled`, `script.execution-started`, `script.execution-finished`, `runtime.exception` and `runtime.terminated`; script events additionally require `acceptHighCost: true`. GC, memory pressure and Promise rejection Observer events remain unsupported.

Admission takes the intersection of Policy, platform support/opt-in and Host caps (256 queued events, 1000 ms callback ceiling). A dedicated 64-slot, 8 KiB-per-message engine queue does not consume Gate command capacity. Subscriber delivery is bounded and lossy; Observer return values and failure diagnostics are not authorization decisions. Inline callbacks still share their plugin's Host closure state and can influence that plugin's later Gate/Middleware logic, so this partial implementation does not enforce monitoring/authorization non-interference. Events contain fixed metadata, virtual origins and digests, not source/body/Host Context. Script execution hooks cover explicit module/CJS execution roots, not every implicit dependency or eval/Function entry; pairs are not guaranteed.

Inline callbacks run in the trusted Host worker, never Guest. Pending asynchronous callbacks do not keep Guest termination open; dispose/close fences late diagnostics. A synchronous infinite inline Host callback can indefinitely block later Host authorization; whole-generation termination needs an explicit Runtime deadline, cancellation or another fatal watchdog condition. Standalone has no deadline by default; select `--timeout` when a bounded run is required. The separately selected diagnostic module mode provides executor isolation, not migration of existing closures or complete Native/M4 coverage. Observer is monitoring, not an authorization hook.
