# Runtime plugins and live reload

[简体中文](../../concepts/runtime-plugins.md)

> The Runtime plugin resource and lifecycle foundation is implemented as an M3 sub-track. Node/Desktop supports startup loading, Capability Middleware graph/drain, and `--watch`. Android supports static synchronous startup Bundles and synchronous Capability interception in a separate Host realm, but not live replacement. See the [support matrix](../capabilities/support-matrix.md) for the exact boundary.

Holonomy uses one plugin model: Host-admitted JavaScript/Cordis plugins. Every target consumes the same `holo-plugins:///*` Bundle contract, but execution support can be a platform subset: Node/Desktop uses a complete generation-owned Cordis App, while Android v1 uses a Host V8 realm isolated from the Guest and synchronous Cordis Contexts.

## Overall relationship

```mermaid
flowchart TD
  host["CLI / Desktop / Android Host"]
  resources["Resource preparation<br/>package · relative path · absolute path"]
  bundle["Runtime Plugin Bundle<br/>holo-plugins:///*"]
  runtime["Holo Runtime<br/>Kernel + Host Plugin Realm"]
  plugins["JavaScript/Cordis Plugins<br/>resource · lifecycle · dispose"]
  bridge["Native Bridge<br/>FS · Network · Device · UI · Process"]
  backend["Node / Android / WASM Linux Backend"]
  guest["Guest JavaScript<br/>node:* / holo:*"]

  host --> resources --> bundle --> runtime
  host --> bridge --> runtime
  runtime --> plugins
  runtime --> guest
  runtime --> bridge --> backend
```

The Native Host does not implement another plugin API. The trusted launch side loads resource bytes and constructs Bundles, while the Native Host supplies the Resource Manifest, Native Bridge, and Runtime lifecycle. The Service admits startup or update transactions, then the Runtime installs plugins into the generation's Host plugin realm. The Guest cannot access that realm's globals, intrinsics, or Cordis Context.

## Code roles

Inside the Runtime, the Kernel/Cordis App, Capability modules, and optional foundation plugins are separate layers. Platform adapters provide only Providers and Native Bridges. The CLI or Native Host prepares plugin resources; the Service owns admission, revisions, and process lifecycle, but does not read a remote caller's local paths.

Plugins may depend on the Context supplied by the Runtime and relative modules within their own Bundle; the Runtime does not depend back on a concrete plugin. Node/Desktop provides `ctx.holo.intercept()` and connects plugin graph revisions, in-flight drain, and disposal to the Capability Broker. `@holonomyjs/plugin-permission` and `@holonomyjs/plugin-audit` provide foundation factories: Holonomy owns the protocol and safe defaults, while the application injects the permission decider and audit sink. Android v1 exposes the same synchronous interception service; asynchronous deciders and sinks are rejected.

A plugin npm package declares its unified entry through `package.json.holo`:

```json
{
  "name": "@company/holo-permission",
  "holo": {
    "kind": "runtime-plugin",
    "apiVersion": 1,
    "entry": "./dist/index.mjs",
    "configSchema": "./dist/config.schema.json"
  }
}
```

The entry must export a JavaScript plugin installable by the Runtime Cordis App. `enabled`, `export`, and `config` default to `true`, `default`, and `{}` respectively. Optional `integrity` pins the expected Bundle digest.

## Plugin resources

Plugin URLs inside the Runtime use a separate scheme:

```text
holo-plugins:///<plugin-instance-id>/<relative-path>
```

This is separate from immutable `holo:///runtime/*` assets. A Bundle contains its entry, every file, configuration, and integrity. The Runtime never sees npm, pnpm, symlinks, or native Host paths.

The CLI configuration is:

```json
{
  "plugins": [
    {
      "id": "permission",
      "use": "@company/holo-permission",
      "config": { "interactive": true }
    },
    {
      "id": "audit",
      "use": "./plugins/local-audit.mjs"
    },
    {
      "id": "security",
      "use": "/opt/company/holo-plugins/security",
      "enabled": true
    }
  ]
}
```

- packages resolve from the workspace that owns the configuration;
- relative paths beginning with `./` or `../` resolve from the directory containing `holo.config.json`;
- absolute paths require explicit Host-policy permission;
- other strings are package specifiers, and v1 does not accept `file:` URLs;
- `run` never installs dependencies over the network during startup or watch.

The CLI resolves, validates, and builds Bundles from the workspace that owns the configuration, then submits an immutable resource graph with no Host paths to the Service. An Android Host can prepare the same Bundle from APK assets or Host-managed storage. The Service and Runtime never read back into the caller's filesystem.

## `watch` mode

The Node/Desktop command is:

```bash
holonomy run app.mjs --config holo.config.json --watch
```

Whenever the configuration changes, the CLI watcher reads the complete file again. A candidate Bundle reaches the Runtime through the Service revision CAS only after JSON parsing, config Schema, plugin Schema, source, and integrity validation all succeed.

The diff uses unique `plugins[].id` values and array order:

- a new ID loads a plugin;
- removal or disablement unloads its Cordis scope;
- source, export, config, or integrity changes stage a replacement before unloading the old instance;
- reordering publishes a new ordered Capability Middleware graph; new calls use the new revision while in-flight calls keep their frozen snapshot;
- an unchanged entry is not reloaded.

Updates use last-known-good semantics. Invalid JSON, duplicate IDs, Schema failures, or plugin load failures emit diagnostics without tearing down the working graph. The Service publishes a new revision only after Runtime replacement succeeds. New Capability invocations use the new graph, in-flight invocations retain the old snapshot, and the retired revision is disposed only after drain.

V1 covers configuration changes and Bundle diffs after re-resolution, not arbitrary source-file HMR. Deleting the configuration file is not treated as an empty plugin list; unloading every plugin requires a valid `"plugins": []`.

Android/Javet does not use runtime dynamic import. Before startup, the Host composes admitted Bundles into a read-only static module manifest and installs them synchronously in a separate Host V8 realm; plugin globals are not visible to the Guest. Android v1 rejects Promise-returning asynchronous plugin initialization and async Middleware, and a failure prevents Guest entry. Static synchronous plugins can intercept Capability calls. Live graph replacement remains future work, and the CLI rejects Android `--watch` deterministically.

## Non-bypassable boundaries

- System Policy, Snapshot, Authority, and Generation fencing are not unloadable plugins.
- Guest code cannot access the Cordis Context or install, reorder, or unload Host plugins.
- Holonomy supplies the Permission/Audit protocols and foundation factories, while the application owns prompts, one-time or persistent decisions, persistence, and audit destinations. Android v1 supports only their synchronous decider/sink subset.
- Node/Desktop plugin disposal cleans resources registered through Cordis Context/effect after the retired graph drains. Android v1 destroys the whole static Host plugin realm only when the generation closes.
