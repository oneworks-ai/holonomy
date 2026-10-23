# Node Adapter

`adapters/node/` owns the Node host for Holonomy Runtime processes. It is an adapter, not a second JavaScript Runtime: guest API semantics remain in the platform-neutral runtime, while this leaf owns Node child-process isolation, `vm` module evaluation, Inspector discovery, host networking and generation-bound IPC.

## Ownership

- `src/supervisor.mjs`: one child process per Runtime, generation changes, request/response IPC, bounded logs and stop/restart cleanup.
- `src/runtime-assets.mjs` and `src/runtime-bootstrap.source.mjs`: load the current shared Runtime implementation into `holonomy:///runtime/*`, compose timers/console/Fetch/module-loader/node compatibility and enter the user URL only after the shared loader creates a plan.
- `src/child-runtime.mjs`: trusted child entry. It creates the `vm` Context, runs the owned bootstrap and emits only generation-bound events.
- `src/module-graph.mjs`: separates adapter-owned `holonomy:///runtime/*` modules from absolute guest URLs and resolves only graph members or Runtime-registered `node:*` synthetic modules.
- `src/runtime-web-standards.mjs`: partial portable URL/TextDecoder shims also embedded in the Native private planner. Empty query/fragment getters match platform URL values while serialization retains the delimiter identity; regression tests compare this seam with Node URL. Nonstream UTF-8 decoding consumes one leading BOM by default and preserves it for `ignoreBOM:true`, including invalid-prefix handling. This is not a complete WHATWG URL/TextDecoder implementation; do not claim streaming decoder support.
- `src/runtime-context.mjs` and `src/runtime-host-controller.mjs`: keep host operations behind a hidden guest-realm facade, reconstruct NativePort events inside the guest realm and own native wakeups/timers/module reads.
- `registerNextTickCheckpoint` carries only a trusted Guest-local queue checkpoint, not user callbacks. Due wakeups coalesce through the Host primitive and cancel by ticket; `null` means cancellation. A selected terminal synchronously exits the per-Runtime child, preventing queued Guest jobs from running afterward. Supervisor's actual OS exit event is generation-fenced; Service never interprets log text as a terminal.
- The bootstrap timer facade registers through the same shared Event Loop as Immediate and nextTick. Host wakeup `next-tick` uses the native tick primitive, while ordinary `event-loop` wakeups use native setImmediate; coalescing includes phase and ticket cancellation clears a pending check handle. These are OS/engine wakeups, not a second JS task queue.
- `src/capability-providers.mjs` owns Provider construction and bounded teardown fan-out. Every Provider's `close` must start synchronously before awaiting teardown; a slow, throwing or rejecting Provider cannot prevent another Provider's revocation prefix from starting before fatal child exit.
- `src/node-network-native-port.mjs`: implements the shared `host.network` v1 provider contract and exact opaque resource binding for the Node transport.
- `src/node-http-network-host.mjs`: owns HTTP(S) transport bytes, DNS/address authorization, exact-address pinning, original-host TLS identity and cancellation. It never implements Fetch redirects.
- `src/capability-fs-resources.mjs` and `src/capability-fs-watch-poll.mjs`: own Node filesystem handle/watch resources. A generation-closed, no-directory-enumeration metadata poll backs up native `fs.watch`; directory fallback events may have `filename: null` and cannot detect an in-place child-file edit if the Host emits no native callback. Shared filesystem API and event semantics remain in `packages/capabilities/fs/`.
- `src/protocol.mjs`: bounded, generation-tagged IPC and session snapshots shared by the supervisor and child.
- `src/node-crypto-provider.mjs` maps the fixed shared crypto primitive port to synchronous Node builtins. `src/node-crypto-bridge.mjs`, `src/node-crypto-binary.mjs` and `src/node-crypto-facade-source.mjs` keep native contexts and functions Host-only, copy binary through captured internal-slot probes, and rebuild outputs inside the Guest realm. Only the Supervisor constructor's `{ crypto: { enabled: true } }` enables installation; session input cannot override that Host choice. The shared port remains the owner of validation, limits, self-test and public lifecycle. Close/terminate synchronously revokes the generation's provider before awaiting other teardown.
- `src/session-validation.mjs` and `src/session-process-input.mjs`: immutable module, argv and environment admission for one child generation.
- `src/capability-process-backend.mjs`, `src/capability-process-profile.mjs`, `src/capability-process-provider.mjs` and `src/capability-process-host-port.mjs`: own Node Backend registration, Host-only installation validation and translation of native/v86 child streams into the shared `packages/capabilities/process/src/host/` Provider port. The shared Host leaf owns Process authority, quotas, resource events and publication. Public Node option and Symbol semantics stay in `packages/capabilities/process/src/kernel/guest-child-process-*`; this adapter must never accept native paths from Runtime input or fall back to ambient `child_process`.
- `src/capability-process-v86-installation.mjs` is the Node production installation seam: it loads only Host-owned regular assets, verifies profile digests before Guest entry, composes FUSE/network bridges, and extends a per-Runtime Registry without mutating the default Registry.
- `backends/v86/`: owns reproducible v86 Linux assets, static supervisor, pinned custom-kernel verification, and lower-level Host-V8 probes. Production support evidence must additionally pass the installed Backend through `NodeRuntimeSupervisor`; stock v86 boot evidence alone never proves Holo FS or Network authority.
- `src/capability-process-v86-capability-broker.mjs` is only the Node alias for `backends/v86/host/capability.mjs`. Keep Device/System command lookup, source translation and bounded admission in that shared family owner; Node supplies its existing Kernel binding and never interprets the same request through a second authority path.
- `src/runtime-plugin-host.mjs` and `src/capability-runtime-plugins.mjs`: stage Cordis Runtime Plugin bundles before entry and replace only complete, validated graph revisions on Node/Desktop.
- `native/engine-gate/`: narrow V8 addon for per-Context string/Wasm compilation callbacks. It is fail-closed, owns no Policy or product decision, and may block only on the dedicated Host decision pipes created by `NodeRuntimeSupervisor`; `src/engine-gate-native.mjs` owns installation and generation-level fallback.
- `native/filesystem-openat/` and `src/capability-fs-openat.mjs`: built-in Host-only N-API directory-relative open primitive. It forces nofollow/nonblocking/close-on-exec, refuses truncation and non-file/non-directory objects, and owns no capability decisions or fd ledger. The FS Provider pins roots/parents, verifies admitted identities, applies authorized truncation and closes descriptors. Never add a path-based fallback, runtime compilation or Guest-selected addon loader.

The fresh guest Context must not receive ambient Node `process`, `require`, `Buffer`, `fetch`, host functions or host-realm objects. Public globals and `node:*` modules are installed only by the shared Holonomy Runtime. NativePort events, including binary, must be reconstructed in the guest realm before entering NativeBridge validation.

Every child message carries the current generation. Late messages are ignored, stop is idempotent and restart creates a fresh OS process. Network rules are trusted host configuration, frozen per revision and never sourced from guest code.

## Verification

```sh
pnpm run build:node:filesystem-hook
node --experimental-vm-modules --test adapters/node/test/*.test.mjs
pnpm exec eslint adapters/node
pnpm exec dprint check adapters/node/src/index.d.mts adapters/node/*.md
```
