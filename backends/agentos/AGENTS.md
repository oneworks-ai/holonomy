# agentOS Backend candidate

This directory records the current agentOS candidate boundary and owns its reproducible probe. It contains no Holonomy Backend implementation and must not be imported, registered, packaged, or listed as supported.

## Candidate identity

- Proposed internal id: `experimental.agentos-v1`.
- Family: `virtual-kernel`.
- Intended Hosts: Node/Desktop only until another platform has its own real packaging and E2E.
- Binary boundary: Backend-packaged WASM tools, not arbitrary Linux ELF.
- Upstream probe artifact: `@rivet-dev/agentos-core@0.2.15`, Apache-2.0, git revision `36843a854ef7609a77d160bce1fd6bce2bb7ebd2`.

## Verified probe boundary

`probe/` is an isolated pnpm package pinned to the exact upstream SDK. From that directory, run `pnpm install && pnpm probe`; build the repository first so the probe can validate its output with `ProcessBackendProbeEvidenceV1`. The checked-in result lives under `evidence/`.

The macOS arm64, Node `22.22.2`, V8 `12.4` behavioral probe verifies installation, boot, workload execution, stdio, exit, VM filesystem, Host-directory read/write with explicit uid/gid mapping, process listing/tree, signal delivery, and explicit VM/sidecar disposal. The fixture deliberately executes the upstream shell and packaged tools; it does not substitute a Host-side mock.

The checked-in cold run took 2.834 seconds to create an owned sidecar and VM and 571 ms for the representative workload. Earlier exploratory runs observed 106–186 ms warm starts. These are probe observations, not product limits or performance promises.

## Unresolved boundary

- The pinned default software bundle does not package `curl`, so the reproducible local HTTP scenario currently records `agentos.curl_not_packaged`. Earlier exploratory WASM-curl work also failed to establish a usable process network path. `networkBridge` therefore remains false; JS fetch success cannot stand in for process-attributed socket authority.
- Distributed sidecars cover Darwin/Linux x64/arm64 and do not provide an Android artifact. `androidPackaging` remains unsupported.
- agentOS is a virtual kernel/runtime, not a complete Linux VM. It must not claim a traditional Linux kernel, arbitrary ELF, or v86-compatible image semantics.
- Snapshot support has not been established for the Holonomy lifecycle and remains unsupported.
- No Host manifest, descriptor artifact, Capability Broker bridge, generation fencing, or public `node:child_process` E2E exists in this repository.

## Implementation entry criteria

Implementation is not scheduled. The completed v86 descendant/lifecycle work is reusable evidence, but it does not authorize resuming this candidate. A new milestone decision must first select the target Host/Engine combination and assign platform E2E ownership. If that happens, keep the SDK/sidecar Driver here, reuse the shared Environment Host Runtime and Process resource protocol, and keep platform worker/process ownership in the relevant adapter. Start with Node/Desktop filesystem, process lifecycle, and stdio while declaring network, snapshots, and Android unsupported. Do not download tools or sidecars from ambient registries during Runtime admission; the Host must install digest-bound artifacts before Guest entry.
