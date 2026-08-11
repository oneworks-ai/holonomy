# Node Adapter

`adapters/node/` owns the Node host for Holonomy Runtime processes. It is an adapter, not a second JavaScript Runtime: guest API semantics remain in the platform-neutral runtime, while this leaf owns Node child-process isolation, `vm` module evaluation, Inspector discovery, host networking and generation-bound IPC.

## Ownership

- `src/supervisor.mjs`: one child process per Runtime, generation changes, request/response IPC, bounded logs and stop/restart cleanup.
- `src/runtime-assets.mjs` and `src/runtime-bootstrap.source.mjs`: load the current shared Runtime implementation into `holonomy:///runtime/*`, compose timers/console/Fetch/module-loader/node compatibility and enter the user URL only after the shared loader creates a plan.
- `src/child-runtime.mjs`: trusted child entry. It creates the `vm` Context, runs the owned bootstrap and emits only generation-bound events.
- `src/module-graph.mjs`: separates adapter-owned `holonomy:///runtime/*` modules from absolute guest URLs and resolves only graph members or Runtime-registered `node:*` synthetic modules.
- `src/runtime-context.mjs` and `src/runtime-host-controller.mjs`: keep host operations behind a hidden guest-realm facade, reconstruct NativePort events inside the guest realm and own native wakeups/timers/module reads.
- `src/node-network-native-port.mjs`: implements the shared `host.network` v1 provider contract and exact opaque resource binding for the Node transport.
- `src/node-http-network-host.mjs`: owns HTTP(S) transport bytes, DNS/address authorization, exact-address pinning, original-host TLS identity and cancellation. It never implements Fetch redirects.
- `src/protocol.mjs`: bounded, generation-tagged IPC and session snapshots shared by the supervisor and child.
- `src/session-validation.mjs` and `src/session-process-input.mjs`: immutable module, argv and environment admission for one child generation.

The fresh guest Context must not receive ambient Node `process`, `require`, `Buffer`, `fetch`, host functions or host-realm objects. Public globals and `node:*` modules are installed only by the shared Holonomy Runtime. NativePort events, including binary, must be reconstructed in the guest realm before entering NativeBridge validation.

Every child message carries the current generation. Late messages are ignored, stop is idempotent and restart creates a fresh OS process. Network rules are trusted host configuration, frozen per revision and never sourced from guest code.

## Verification

```sh
node --experimental-vm-modules --test adapters/node/test/*.test.mjs
pnpm exec eslint adapters/node
pnpm exec dprint check adapters/node/src/index.d.mts adapters/node/*.md
```
