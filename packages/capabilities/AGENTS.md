# Capability packages

`network/src/web/fetch-runtime.ts` owns active response-body signal-abort terminal selection; `web-body.ts` consumes its trusted abort-failure hook without translating arbitrary Guest reasons. Keep those reasons Guest-local, Provider/EOF terminals first, and Host cancellation/diagnostic metadata fixed. Explicit reader cancellation and Runtime disposal retain their separate contracts.

Each directory under `packages/capabilities/` is an independently packaged JavaScript Capability module:

- `fs/`: `node:fs`, virtual path/handle/watch contracts and Linux filesystem bridge.
- `device/`: `holo:device`, readings, events and Provider descriptor contracts.

- `system/`: `node:os`/`node:process` Host System projection contracts.
- `storage/`: unified Storage Policy, canonical KV/SQL resources, operation/argument/result registries and Host invocation mapping; the existing Runtime StorageFacade/NativeBridge remains the API/transport owner.
- `network/`: Fetch/network invocation, Linux process-network bridge and Web network facade.
- `process/`: `node:child_process`, Process resources, descendant routing, supervisor protocol and the legacy Git-only compatibility facade.

Device's `guest-device-read-observer.ts` copies successful independent getters' source revisions into active controllers without incrementing them; `device-resync-ack.ts` snapshots/validates resync bounds. `guest-device-subscription.ts` remains the sole Guest queue/overflow/close owner. Read knowledge must not suppress an initial snapshot or authorize unknown future revisions; Summary and failed getters do not add it.

`src/kernel/` contains platform-neutral schema, facade and Broker-facing code. A package may have another explicit leaf such as `fs/src/node`, `network/src/web` or `process/src/legacy`. `process/src/host/` is the exception that owns the single Backend-neutral Host Process Provider and resource ledger; adapters supply only OS/VM I/O ports and Host-only installation inputs.

The Process Host event channel enforces cumulative bytes and retained-event count, reserves error/close slots, and checks raw output length before base64/hash work. Its pre-return native-port event staging is separately bounded; close terminal delivery must release both Host and Guest subscription slots.

Process Guest `guest-child-process-resources.ts` owns child listeners and the single error terminal. `guest-child-process-abort.ts` attaches the prepared signal, uses the existing kill path and emits a Guest-local AbortError only on successful kill; output collectors reuse that exact error rather than infer a second error from signal state. Adapters must pass the existing `processControl.nextTick` delegate for pre-aborted delivery; the direct scheduler-free test facade has only a Promise-microtask fallback. No Provider event, public emit method or second resource table is created for Abort.

Capability packages may import the public `@holonomyjs/runtime/kernel/*` contract. They must not import Runtime App instances, adapters, Host paths or platform I/O. Node/Android/Desktop Providers belong in `adapters/*`; Linux/virtual environment machinery belongs in `backends/*`.

The old `src/capability-runtime`, `src/node-fs`, `src/web-network` and `src/child-process` paths are compatibility re-exports only. New implementation must be added here.
