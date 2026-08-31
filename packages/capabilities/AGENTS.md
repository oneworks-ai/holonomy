# Capability packages

Each directory under `packages/capabilities/` is an independently packaged JavaScript Capability module:

- `fs/`: `node:fs`, virtual path/handle/watch contracts and Linux filesystem bridge.
- `device/`: `holo:device`, readings, events and Provider descriptor contracts.
- `system/`: `node:os`/`node:process` Host System projection contracts.
- `network/`: Fetch/network invocation, Linux process-network bridge and Web network facade.
- `process/`: `node:child_process`, Process resources, descendant routing, supervisor protocol and the legacy Git-only compatibility facade.

`src/kernel/` contains platform-neutral schema, facade and Broker-facing code. A package may have another explicit leaf such as `fs/src/node`, `network/src/web` or `process/src/legacy`; these remain JavaScript-facing contracts, not Host Provider implementations.

Capability packages may import the public `@holonomyjs/runtime/kernel/*` contract. They must not import Runtime App instances, adapters, Host paths or platform I/O. Node/Android/Desktop Providers belong in `adapters/*`; Linux/virtual environment machinery belongs in `backends/*`.

The old `src/capability-runtime`, `src/node-fs`, `src/web-network` and `src/child-process` paths are compatibility re-exports only. New implementation must be added here.
