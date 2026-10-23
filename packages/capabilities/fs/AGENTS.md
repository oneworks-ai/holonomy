# Filesystem Capability

- `src/kernel/` owns the shared `node:fs` facade, operation/argument/result registries, virtual handles and the Linux filesystem Capability Bridge. Public API semantics stay here; adapters implement only authorized OS I/O.
- `chmod` is a separate FS right; write/open rights do not imply it. File and directory descriptors identify the retained object, while metadata mode changes use a fresh capability selection. Linux typed MODE expectations live only in source-gated readback arguments and must be checked against the final FD before the effect; keep public no-readback args strict.
- `src/kernel/filesystem-path-segment.ts` owns canonical URI-encoded filesystem capability prefix segments and their standalone machine schema. These are path segments, not identifiers; root IDs remain identifiers. Keep canonical percent spelling, UTF-8 and per-native-name byte bounds aligned with `normalize-filesystem.ts` and Runtime resource identity.
- `src/node/` owns the separate NativePort FS facade and conformance memory Provider. The memory Provider is not a production platform implementation.
- Node OS adaptation is in `adapters/node/src/capability-fs*`; standalone Rust adaptation is in `adapters/desktop/host-core/src/filesystem*`. FUSE wire/inode state is shared under `backends/v86/host/`; it must re-enter the Kernel through this package's Linux bridge.

Read the parent [Capability guide](../AGENTS.md) and [testing ownership](../../../.oo/rules/testing-strategy.md). Lowest-layer schema/selection cases live under `__tests__/js-runtime-kernel/capability-runtime/`; public JS journeys live under `conformance/capabilities/`.
