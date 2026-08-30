# HoloUV environment runtime

`@holonomyjs/holouv` owns the Backend-neutral environment lifecycle shared by Native, v86 and future process Backends. It is not a libuv ABI implementation and does not expose `uv_*` memory structures.

- `src/environment-runtime.ts` owns runtime/process-tree environment reuse, generation fencing and deterministic close.
- Public `node:child_process` semantics and Process Backend contracts remain in `@holonomyjs/capability-process`.
- Backend boot and Guest System adaptation remain under `backends/*`; Host OS and engine integration remain under `adapters/*`.
- Do not add filesystem, network, device or credential authority here. Those operations must re-enter the shared Capability Broker through Backend adapters.

Verify changes with `pnpm typecheck`, `pnpm test:runtime`, `pnpm test:adapter:node`, `pnpm test:package`, `pnpm lint` and `pnpm format:check`.
