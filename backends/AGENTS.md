# Environment Backend families

`backends/` owns stable internal routing notes and future platform-neutral assets for Process Environment Backend families. A directory here is not an installed implementation, Registry entry, public support claim, or evidence that a Backend can be selected by a Host profile.

## Current routing

- Stable Native Darwin execution is implemented by `adapters/node/src/capability-process-native-backend.mjs` and the adjacent Seatbelt launcher. It is a real `ProcessBackendV1`, not a generic timer/FS/device NativePort and not a documentation-only symmetry layer.
- Experimental v86 is currently split between the Node implementation under `adapters/node/src/capability-process-v86-*.mjs`, reproducible assets and probes under `backends/v86/`, and optional Android packaging under `adapters/android/process-backend-v86/`. Do not create a second v86 implementation here until that shared-code extraction is deliberate.
- `agentos/` and `wasix/` are research-only candidates with isolated, reproducible upstream probes and checked-in evidence. Neither has Holonomy integration code, a checked-in implementation descriptor, a Host installation path, a Provider registration, or support-matrix status. Run `node backends/verify-evidence.mjs` after building the repository to validate every checked-in result against `ProcessBackendProbeEvidenceV1`.

## Ownership model

- `packages/runtime/src/kernel/` owns the shared Policy, Broker, CanonicalResource base, error translation and generation/resource lifecycle contracts.
- `packages/capabilities/process/src/kernel/` owns the public `node:child_process` facade, Process Registry, Process resource protocol and Backend-neutral Process contracts.
- `packages/holouv/` owns the reusable Environment Host Runtime for VM/worker-style Backends: environment/process/stdio resources, lifecycle fencing and Capability Bridge re-entry. Native Darwin directly implements the same Process Backend SPI and conformance without constructing a redundant VM-environment object.
- `backends/<family>/` owns only family-specific boot, binary, transport, Guest Agent or SDK adaptation, and reproducible assets that are platform neutral.
- `adapters/<platform>/` owns Host Platform and JavaScript Engine integration, packaging, native processes/workers, platform resource loading, and platform E2E.
- A Guest System Adapter owns path, argv, shell, signal, process-tree, uid/gid, PTY, and error semantics. Windows, Darwin, Linux POSIX, WASIX, and agentOS semantics must not be hidden inside one generic Driver.

## Admission rule

Do not add a candidate to a default or installed Backend Registry until all of these exist:

1. an exact machine-validated descriptor and Host-only configuration schema;
2. digest-bound artifacts with license and provenance records and no ambient runtime download;
3. Provider/resource lifecycle integration with stop, restart, cancellation, late-event fencing, and tree cleanup;
4. Broker re-entry for every exposed file, network, device, system, mount, or credential capability;
5. real public-facade E2E on every claimed Host/Engine/Backend/System combination;
6. bilingual support documentation that distinguishes Stable, Experimental, unsupported, and evidence-limited behavior.

Native exists because the same public Process contract, profile admission, authority, resource state machine, feature detection, and cleanup must apply whether execution occurs on the Host OS or inside a virtual environment. It also provides the Stable reference Backend for shared conformance. It must never become an ambient fallback when a selected virtual Backend is missing or denied.

## Descendant execution boundary

- Root invocation admission and descendant execution control are separate capabilities. Every Backend must admit the initial `node:child_process` request through the shared Broker before starting work.
- Native Darwin currently provides static Seatbelt containment for the whole process tree. It does not provide a Cordis callback before every descendant `exec`, and v86 must not be used as a substitute when the workload requires macOS Mach-O programs.
- v86 uses a Guest Agent plus a seccomp user-notification gate for `execve` and the supported absolute `execveat` form. It reports `{ pid, ppid, executable, argv, cwd }`, waits for the generation-bound Host decision, and fails closed on unknown, relative, timed-out, cancelled, or stale targets.
- Run `pnpm test:m35:v86:guest` with `HOLO_V86_PRODUCTION_ASSET_ROOT` and the pinned Zig `0.16.0` path in `HOLO_V86_ZIG_PATH` for the private Guest gate/FUSE conformance overlay. This fixture must not enter a production image.
- The shared v86 capability bridge owns one `/workspace` FUSE mount, TCP/UDP/DNS, Host Device/System projection, and descendant admission. Backend launch validation must reject any mount capable of shadowing image executables.
- A later descriptor version must distinguish static containment, observation-only, and pre-execution authorization. Do not infer one level from `processTree`, `shell`, or signal support.
- agentOS and WASIX stay research-only. Do not resume implementation on either family unless a new design decision adds it to an active milestone and assigns platform E2E ownership.
