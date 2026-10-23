# Native desktop Holonomy

[简体中文](README.zh-Hans.md)

The standalone `holo` executable embeds V8 through Rust and `rusty_v8`. It runs without Node.js installed and carries the shared Holonomy JavaScript Runtime inside the executable. The current native desktop target is under development; verified execution is macOS arm64.

Build from the repository root with Rust 1.94.1 and the repository's pnpm dependencies installed:

```sh
pnpm build:native
./target/release/holo ./index.js
./target/release/holo --timeout 5000 ./index.mjs argument
./target/release/holo test ./conformance/specs/timers.test.mjs
./target/release/holo engine info --json
```

Node and esbuild are build tools only. Copy `target/release/holo` to run it without the source checkout or `node_modules`.

Current execution supports CommonJS `.js`/`.cjs`, ESM `.mjs` and package `type: module`, static and dynamic imports, top-level await, JSON via require, shared pure-JS `node:*` modules, console, timers and `node:test`. Module lookup stays within the selected source root (the entry directory by default). It follows only relative package-directory links under `node_modules` whose targets stay in that root; ordinary file links, absolute links and root escapes are rejected. It uses the existing Holonomy module planner; this is not a claim of full npm, Node or native-addon compatibility.

For an owner-selected project with a nested entry, use `holo --module-root ./project ./project/src/index.js`. Sibling imports and package lookup remain inside that explicit directory, with virtual identity `app://workspace/src/index.js`. `holo test --module-root ./project ./project/tests/a.mjs ./project/tests/b.mjs` checks every file's containment before the first test runs. This flag does not grant `node:fs`, change Guest cwd, discover a broader project automatically or expose private Host files. Omit it to retain the entry-directory boundary; after the entry it is ordinary Guest argv.

CommonJS `require('node:assert/strict')` and `require('node:test')` are callable, and `require('node:process')` returns the same object as global `process`. ESM named exports retain their separate snapshot semantics.

`process.nextTick(callback, ...args)` uses the existing Runtime Event Loop and returns `undefined`. It preserves argument identity and FIFO/nested order; invalid callbacks synchronously fail with `ERR_INVALID_ARG_TYPE`. Direct CommonJS entry ticks precede Promise jobs; ESM entry Promise jobs precede ticks. Timer-callback ticks run before that callback's Promise jobs. A tick-only checkpoint never advances a ready timer. Recursive ticks remain subject to the Runtime's callback budget and execution deadline; this is not an unbounded Node starvation guarantee.

Global and `node:timers` `setImmediate`/`clearImmediate` use that same loop. Immediate handles preserve callback `this`/argument identity, provide `ref`/`unref`/`hasRef`, and cancel with `[Symbol.dispose]` when the engine exposes it. Each callback has its own tick/Promise boundary; nested immediates wait for a later batch. An unreferenced immediate alone does not keep the executable alive. This bounded check-batch model is not a claim of full libuv poll/I/O-phase equivalence.

Fatal callback, entry and unhandled-rejection diagnostics use bounded native Error data, never Guest `stack`, coercion or formatting hooks. Proxy, accessor-message and unsafe values use fixed fallback text. Virtual locations are tied to V8 script IDs recorded at admitted compilation, not Guest `sourceURL` names; unknown IDs or exhausted diagnostic metadata omit the location without blocking execution. The registry retains at most 4,096 URLs of at most 512 bytes and captures at most 32 native stack frames. A complete original stack and exact Node error wording are not guaranteed.

Unhandled rejection is decided after Promise jobs and the existing nextTick phase can attach handlers, but before another ordinary timer runs. Direct CommonJS synchronous failure skips queued jobs; standalone ESM failure may run prior Promise jobs. A configured Host retains its no-Guest-reentry cleanup fence.

The JavaScript `holonomy run/test --target native` frontend uses an owner-installed local Rust source reader before contacting Service. Native descriptor-relative reads register selected Host config/plugin/token identities before collecting the Guest graph; same-file and hardlink cross-role publication fails closed. One reader lease is retained for CLI config watch, including rejection of Guest-to-Host source promotion. The installation locator itself is a bounded Host bootstrap read used to select that binary; source and plugin-code bytes do not fall back to Node filesystem reads.

The shared resolver collects package imports/exports, JSON and positive package metadata into a finite source snapshot. Within-root pnpm package links resolve to their canonical virtual URLs, so transitive lookup and singleton identity use the actual package location. Service stages canonical files only and validates a bounded, flat alias map; its digest and private exact URL allowlist cover both sides. Opaque builtin references are not fake bindings: the actual Native Runtime still validates availability, export names and admission. Computed imports can only reach the captured set. Native `run` preserves the actual CJS/ESM main entry, including nested entries; the private execution workspace is Service-derived, never a public Host-path option. Query and empty-fragment identities remain separate; conflicting bytes for one physical staging path reject preparation.

CommonJS supports `require.main === module`, `module.id`/`filename`/`loaded` and planned `require.resolve()`. Filenames and resolved values are canonical virtual URLs, never native paths. Resolve does not execute a target or grant a new load: an aliased require of a resolve-only edge rejects with `ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED`. `require.cache`, alternate resolve search paths and a complete Node Module object are not supported.

`holo test a.test.mjs b.test.mjs` accepts 1–256 explicit files, preflights every input, then runs each file sequentially in an independent Runtime. It emits one JSON report line per file; any failure makes the final exit code nonzero. `--timeout` is one total deadline across all files. Automatic discovery and built-in globs are not supported. `process.exit(0)` before test completion is not a pass; ordinary `holo index.js ...` application arguments and exit behavior are unchanged.

Package `imports` supports private `#alias` names, single-star patterns, ordered nested `import`/`require`/`default` conditions, arrays/null and external package targets. A nearer package owns its mappings; lookup never crosses a `node_modules` boundary. Own-package `name`/`exports` references use the same resolver. For example:

```json
{
  "type": "module",
  "imports": {
    "#internal": "./src/internal.mjs",
    "#feature/*": "./src/features/*.mjs",
    "#dependency": "dependency/subpath",
    "#path": "path"
  }
}
```

Imports and explicit exports select exact URLs: no implicit extension or directory-index fallback. A physical extensionless JavaScript target uses its nearest package `type`; other unsupported formats and native addons remain denied. Bare built-in names only alias an exact `node:*` module already declared by the Host. A package mapping to literal `node:path` is invalid; use bare `path`. Conditions follow manifest key order, not preferred-condition order; Holonomy's fixed production/source profiles do not expose arbitrary Node custom conditions.

Package links are navigation facts, not new filesystem grants. Requested and resolved sources retain the same private-namespace/inode checks. Self-contained Host plugin packages use a separate private pinned-package reader for within-root pnpm installation; config/token and package leaf reads remain nofollow. Workspace links to a store outside the selected root are unsupported; the runtime does not widen the root or install dependencies automatically. Planning failures report safe public codes; dynamic import creates an Error in the receiving Guest realm with an own `code`, not a private planner Error. No native path/source is copied. Directory targets safely fail, but the Native file-only port's diagnostic differs from Node's directory-import code. This is not complete npm/pnpm compatibility.

`process.versions` reports `holonomy` and `v8`, not a fabricated Node version. Host environment and identity are not implicitly inherited. `--host-config` connects the isolated shared Policy/Broker, Host System projections and the native FS deny-symlink profile: file reads/writes, binary data, open/close/FileHandle, stat/lstat, directories, rename, unlink and watcher/AsyncIterator. The existing complete FS JavaScript conformance file passes on macOS arm64 native `holo`. An opt-in withinRoot subset re-admits resolved targets and pins native descriptors; see [Host configuration](host-configuration.md) for its narrower operation matrix.

Native HTTP(S) now uses the same Policy/Broker with pinned DNS, verified TLS, redirects, Abort, quotas and Host-only mocks. Initial self-contained Cordis ESM plugins load in the Host Context before Guest entry, including real capability interception; package/root integrity and private child-launch identity are checked. Configuration and limits are in [Host configuration](host-configuration.md). Explicit Host profiles also enable the bounded [Native macOS Process subset](process-native-darwin.md), with no Node dependency or ambient command fallback.

Use `holo --watch --host-config ./holo.config.json ./index.mjs` for validated plugin-array replacement without restarting the Guest entry. In-flight calls retain their original plugin graph; failed candidates retain the last good graph. This watches configuration changes, not arbitrary source-file HMR. See [Host configuration](host-configuration.md).

Native Crypto is installed without Host configuration: SHA-1/SHA-256, HMAC-SHA256, AES-256-GCM, synchronous random bytes/UUIDs, timing-safe comparison and Web `getRandomValues`/`randomUUID`. It reuses the shared JS facades over native primitives and runs the required self-test before entry. See [Crypto usage and limits](crypto.md); this is not full Node Crypto or Web SubtleCrypto support.

[Desktop Device](device.md) is explicitly installable on macOS arm64: form-factor, display, input, lifecycle, typed Summary and display/lifecycle subscriptions use the shared facade and Policy/Broker. Live getter/snapshot/overflow/resync/lifetime paths are verified; physical display/lifecycle changes remain evidence-limited. It does not open HID devices or read input reports, screen images or raw identifiers.

Controlled eval/Function, BufferSource WebAssembly compilation and `compileStreaming`/`instantiateStreaming` from genuine Runtime Responses are available through the Host Cordis Engine Gate; they stay denied without their respective Policy permission and explicit approval. See [Engine Gate](engine-gate.md). Streaming reads the bounded body before compilation rather than compiling incrementally. With Host Policy enabled, dynamic import requires its own controlled Policy and explicit Gate approval. Explicit Host-only request-body inspection and partial module/terminal Observer events are available; see [Host configuration](host-configuration.md) for limits, including incomplete synchronous Observer callback isolation. [Native Storage](storage.md) is explicitly installable for persistent KV and SQLite, through the shared Policy/Cordis path; a credential Provider is not installed. An experimental [private Inspector](inspector.md) and the external machine Service's Native `run/test` target are available; experimental Service CDP leases, entry waiting/resume and generation-bound connection cleanup are connected. Full frontend compatibility remains unclaimed. Existing Node and Android support does not imply native desktop support.

An opt-in `v86-backend` Cargo build has booted a SHA-verified Linux image in a dedicated Node-free rusty_v8 isolate and received its UART `HOLO_READY` frame. With owner-private manifests and `--experimental-v86-process`, real Guest cases passed `spawn('cat')` stdin echo/stdout/exit/close and `execFile('echo')` plus a controlled shell `exec('printf ...')` with exact callbacks. The upgraded image rejects every Guest fork/clone and every exec after the trusted root's initial exec; a real self-exec denial case passed. Native Linux FUSE passed bidirectional I/O and attributed denial; [bounded networking](process-v86-network.md) passed actual Linux TCP/UDP, Host DNS, curl HTTP and direct/redirect denial through the same Kernel/Broker. It remains Experimental, not full TLS, address-family or network-tool compatibility. The scoped FUSE checks cover ACCESS, file/directory fsync, metadata and chmod, plus Git init/status; deeper process trees, full POSIX/Git compatibility and broader Process/FS acceptance remain open. The default executable does not bundle or enable v86.

[One-shot Linux Device/System reads](process-v86-capabilities.md) are separately opt-in. They preserve per-process source routing, typed Host projections, precision/privacy ceilings and middleware denial; they do not grant Linux event subscriptions. Native v86 network lifecycle tests also cover pre-/post-spawn AbortError delivery, concurrent VM teardown, socket quota recovery and fresh-Runtime isolation. These remain scoped Experimental evidence.

Each invocation owns one isolated child of the same binary. Explicit exit codes propagate, unhandled rejections fail, `--timeout` interrupts synchronous and microtask loops, and closing the launch control pipe cancels an orphaned Runtime.

On macOS, SIGINT (Ctrl-C), SIGTERM and SIGHUP cancel the invocation and return 130, 143 and 129 respectively. The CLI allows one second for cleanup before force-stopping its private Runtime process group; a second signal requests immediate force-stop. These are CLI shutdown semantics, not support for JavaScript `process.on('SIGINT')` handlers.

With Host configuration, its plugins and Providers run in a separate V8 isolate/native thread inside that Runtime process. Host timers and asynchronous work continue while user JavaScript is busy. The runtime deadline and owner disconnect cancel both isolates. The same Host plugin graph also owns asynchronous controlled-string decisions.

To create a local development archive after building, run `pnpm package:native --output ./target/my-native-artifact`. The output directory must not already exist. The command verifies the Runtime, Host control, plugin-validator and module-planner asset digests, extracts the archive and executes the delivered binary with an empty `PATH`. The directory contains the archive, `manifest.json`, `verification.json` and `SHA256SUMS`; unpack it and run `bin/holo ./index.js`. `--binary FILE` selects a different already-built binary, but stale assets or a mismatched version are rejected.

`verification.json` is published last. Without it, the attempt is incomplete. Before publication, the archive-extracted executable also runs exact-digest Wasm code returning 42 and verifies Wasm/dynamic-import allow-deny, including a denied cached import with no second side effect. Failure cleans only private staging; the output directory and any partial files remain untouched. Choose a new output directory for a retry. These scoped same-machine smokes do not establish clean-machine compatibility or complete M4 acceptance.

The binary uses the standard snapshot and ICU supplied by the pinned upstream `v8` crate. The development manifest records lockfile hashes and the exact binary/embedded JS digests, not a reproducible-build attestation. These archives are not publishable releases: signing, notarization, installation/update management and complete third-party redistribution notices/SBOM remain pending. The included LICENSE covers Holonomy itself.
