# Runtime package

`@holonomyjs/runtime` is the platform-neutral Runtime and Cordis composition package.

- `src/app/` owns Runtime creation, Cordis App/plugin graph, lifecycle and the reviewed default module composition.
- `src/kernel/` owns shared Policy, Broker, invocation snapshots, authority, canonical-resource bases, resource registry, error delivery and machine contracts.
- `src/native-port/`, `src/event-loop/`, `src/module-loader/`, `src/node-compat/`, `src/streams/` and the other leaf directories own system-independent JavaScript runtime primitives.
- Capability-specific facades and registries belong in `packages/capabilities/*`; platform Providers and engines belong in `adapters/*`; environment implementations belong in `backends/*`.
- The package may compose official Capability entrypoints, but Kernel leaves must not import platform Provider implementations or own Host I/O.

Build output is generated in `dist/` by the root `pnpm build`. Do not edit `dist/` or the checked-in machine JSON directly.

Verify changes with `pnpm typecheck`, `pnpm test:runtime`, `pnpm contracts:check`, `pnpm lint` and `pnpm format:check`.
