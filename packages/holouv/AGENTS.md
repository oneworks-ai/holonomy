# HoloUV environment runtime

`@holonomyjs/holouv` owns the Backend-neutral lifecycle for Backends that create reusable or isolated execution environments. The current v1 implementation is instantiated by v86. Native Darwin implements the same public Process Backend SPI and conformance semantics directly because one Host process launch does not require a separate VM-environment object. It is not a libuv ABI implementation and does not expose `uv_*` memory structures.

- `src/environment-runtime.ts` owns runtime/process-tree environment reuse, generation fencing and deterministic close.
- Do not claim that a Backend uses `HoloUvEnvironmentRuntimeV1` unless its adapter actually instantiates it; sharing the Process SPI and vectors is distinct from sharing this environment object.
- Public `node:child_process` semantics and Process Backend contracts remain in `@holonomyjs/capability-process`.
- Backend boot and Guest System adaptation remain under `backends/*`; Host OS and engine integration remain under `adapters/*`.
- Do not add filesystem, network, device or credential authority here. Those operations must re-enter the shared Capability Broker through Backend adapters.

Verify changes with `pnpm typecheck`, `pnpm test:runtime`, `pnpm test:adapter:node`, `pnpm test:package`, `pnpm lint` and `pnpm format:check`.
