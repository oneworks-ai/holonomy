# WASIX Backend candidate

This directory records the current WASIX candidate boundary and owns its reproducible current/compatibility probes. It contains no Holonomy Backend implementation and must not be imported, registered, packaged, or listed as supported.

## Candidate identity

- Proposed internal id: `experimental.wasix-js-v1`.
- Family: `wasix`.
- Intended Hosts: Node/Desktop only until another platform has its own real worker/runtime integration.
- Binary boundary: WASI/WASIX-compiled modules and packages, never ordinary Linux ELF.
- Current upstream probe artifact: `@wasmer/sdk@0.10.0`, MIT, source revision `7e3a7a35f35f6fb15229b06a567ed838a97b7cca`.

## Verified probe boundary

`probe/current/` and `probe/compatibility/` are separate pnpm packages so their Worker runtimes and exact SDK versions cannot contaminate each other. Run `pnpm install && pnpm probe` inside either directory after building the repository. Both normalize their output through `ProcessBackendProbeEvidenceV1`; checked-in results live under `evidence/`.

On macOS arm64, Node `22.22.2`, and V8 `12.4`, SDK `0.10.0` installed and initialized, but the minimal local module failed in the worker with `Not able to serialize module`. This matches the open upstream module-serialization regression tracked in [wasmer-js issue 468](https://github.com/wasmerio/wasmer-js/issues/468). The current SDK therefore has no successful workload, stdio, exit, or filesystem evidence for a Holonomy Backend.

A separate compatibility probe with SDK `0.9.0` executes the same checked-in WAT fixture. The Guest module reads stdin, writes stdout/stderr, exits with code `7`, reads a Host-created file through WASI `path_open`/`fd_read`, and writes a second file through `path_open`/`fd_write`. The controller then observes that Workers remain alive after `Runtime.free()` and terminates the isolated child. It is compatibility evidence only and is not a production version selection.

## Unresolved boundary

- There is no reliable kill/signal/abort API or process-tree cleanup contract suitable for `closeGeneration()`. The older package-resolution subprocess scenario was not reconstructed into the current minimal probe and remains recorded only as prior research.
- Networking is incomplete and uses an environment-level WebSocket gateway rather than Holonomy's per-process connect authority. `networkBridge` remains false.
- Filesystem support is a virtual Directory mount. A Holo FS snapshot/import and explicit writeback transaction are required before `filesystemBridge` can be true.
- Snapshot/restore is not available for the required Runtime lifecycle.
- The JavaScript SDK requires browser Workers or Node `worker_threads`. The current Android Javet Host supplies neither, so Android packaging remains unsupported.
- No Host manifest, descriptor artifact, Capability Broker bridge, generation fencing, or public `node:child_process` E2E exists in this repository.

## Implementation entry criteria

Implementation is not scheduled and does not automatically follow agentOS or v86. A new milestone decision must first select the target Host/Engine combination and assign platform E2E ownership. Do not pin SDK `0.9.0` as a production workaround. If the candidate is later authorized, wait for or deliberately patch the current serialization regression, then prove that a Host-owned dedicated Worker or process can terminate the full environment on generation close. Reuse the shared Environment Host Runtime and Process resource protocol, install digest-bound packages before Guest entry, and begin with an Experimental `processTree`-only profile for recompiled WASI/WASIX workloads. Network, snapshots, shell, signals, synchronous spawn, Host live-path mounts, and Android remain false until independently implemented and verified.
