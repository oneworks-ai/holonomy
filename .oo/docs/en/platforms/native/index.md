# Standalone Native `holo`

The first development delivery stays at `1.0.0-rc.3`: a standalone macOS arm64 binary and an embedded Android source SDK. It is neither a general-platform production release nor a complete Node.js replacement. The default archive contains no Linux VM. Signing, notarization, complete redistribution clearance and physical Android acceptance remain separate gates, regardless of local regression results. See [first development delivery](../../getting-started/development-release.md).

[简体中文](../../../platforms/native/index.md)

`holo` embeds V8 with Rust and `rusty_v8` to run JavaScript directly on a computer. The currently verified platform is macOS arm64, delivered as a development binary.

## First run

A source build needs the repository-pinned Rust toolchain and pnpm dependencies:

```sh
pnpm install
pnpm build:native
```

Create `index.js`:

```js
const assert = require('node:assert/strict')
assert.equal(process.versions.node, undefined)
console.log('Hello from standalone Holonomy')
```

Run it from the directory containing that file:

```sh
/path/to/holonomy/target/release/holo ./index.js
```

Execution does not depend on an installed Node runtime, Holonomy's own `node_modules`, or the source checkout. Applications importing external npm packages must still supply their dependencies within the supported module-loading boundary. Node/esbuild are source-build tools only.

## Common commands

```sh
holo ./index.js argument
holo --timeout 5000 ./index.mjs
holo test ./example.test.mjs
holo --host-config ./host.json ./index.mjs
holo engine info --json
```

The default configuration does not inherit Host environment variables or grant file/network capabilities. Host configuration selects Policy, directories, System fields, and Cordis plugins. See the [Native module guide](../../../../../adapters/desktop/README.md) and [Host configuration](../../../../../adapters/desktop/host-configuration.md).

Native support is independent of Node/Android. File/directory watching, explicitly authorized Host request-body inspection, optional [source-read audit](../../../../../adapters/desktop/managed-source-audit.md) (including a separate Service installation) and partial Host-only Observer events are available. Experimental [private Inspector](../../../../../adapters/desktop/inspector.md) and [external Service Native target](../../../../../tools/service/README.md) are also available; the latter supports initial plugin Bundles, configuration-array updates and applied acknowledgements while Native execution remains Node-free. [Partial Storage](../../../../../adapters/desktop/storage.md) provides explicitly installed persistent KV/SQLite, through unified per-call Policy/Cordis interception; a credential Provider is not installed. Experimental Service Inspector leases now support entry waiting/resume and generation cleanup. Explicit [isolated diagnostic profiles](../../../../../adapters/desktop/observer-profiles.md) run in dedicated helper processes/isolates and write bounded private JSONL; owner-private [Service profile installation](../../../../../adapters/desktop/managed-observer-profiles.md), logical ID selection and generation-owned output are also available; old inline callbacks remain partial. Broader Process/network bridging, complete M4 and production-release acceptance remain unfinished. Development archives have not completed signing, notarization, or the full redistribution-license closure.
