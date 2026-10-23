# Controlled process capability

[简体中文](../../capabilities/process.md)

M3.5 publishes one explicit opt-in Process profile, not a passthrough to host `child_process`. The current Stable combination is `process-profile-v1` with `native.darwin-seatbelt-v1` on macOS Node/Desktop. Node/Desktop provides the Host-installed Experimental `experimental.v86-v1`; Android now has an optional production-AAR integration for the same Backend, still marked Experimental. Neither path ships Linux assets in the core package by default. agentOS and WASIX remain candidates.

The standalone Rust/V8 `holo` also connects this Backend's bounded macOS subset: real JS cases cover sync/callback/shell, binary stdio, timeout/Abort, plugin watch and cleanup without a Node helper. It defaults to denied, requires an explicit private profile, allows only `processTree`, no network or mounts, and denies descendant fork/re-exec. See [Native macOS Process](../../../../adapters/desktop/process-native-darwin.md); the Node Adapter's broader platform claims do not automatically apply to this new target.

## Inside the Runtime

The entry points remain Node-compatible:

```js
import { execFile, spawnSync } from 'node:child_process'

import { childProcessEnvironment } from 'holo:runtime'

const result = spawnSync('node-helper', ['-e', 'process.stdout.write("ok")'], {
  [childProcessEnvironment]: { scope: 'processTree' },
  timeout: 5_000
})

execFile(
  'node-helper',
  ['task.mjs'],
  { maxBuffer: 1024 * 1024 },
  (error, stdout, stderr) => {
    if (error) throw error
    // Node-compatible three-argument callback.
  }
)
```

The current facade covers `spawn`, `execFile`, `exec`, and their three synchronous variants. It provides controlled stdin/stdout/stderr, pause/resume, signals, timeout, AbortSignal, and bounded output. A program name is an `executableId` from the Host manifest; no PATH lookup or host absolute path is accepted.

`pause()` stops delivery to Runtime code only; it does not stop the Host from reading and accounting for stdout/stderr. Exceeding the output limit while paused still terminates the complete process tree. The Host also enforces `maxConcurrentProcesses`, `maxTotalProcesses`, and `maxOpenPipes`, and synchronous entry points count toward the total process limit.

A child can retain at most 256 unsettled stdin callbacks; an empty-string write also occupies one callback slot. Settlement or process close frees the slots, and exceeding the limit returns a controlled resource-limit error.

`childProcessEnvironment` is a Symbol so it does not consume a string field in Node options. Omitting it selects the Host default, and Runtime code can request only a Host-allowed scope. Every current v86 Host declares only `processTree`: each root child owns one VM, cleaned up on close, stop, or restart. Shared `runtime` VMs are unavailable until network packets carry nontransferable Linux PID identity. Other Backends may separately declare persistent environments; Runtime code still cannot choose a Backend, image, mount, network, or credential.

## Host configuration

Native paths live only in the private Service manifest and never enter Runtime launch JSON. The default is `$HOLONOMY_HOME/process-profiles.json`, or `~/.holonomy/process-profiles.json` when `HOLONOMY_HOME` is unset. It must be a regular, non-symlink, owner-only file, for example:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "developer": {
      "profile": "process-profile-v1",
      "backend": {
        "backendId": "native.darwin-seatbelt-v1",
        "configuration": {
          "sandboxExecutablePath": "/usr/bin/sandbox-exec",
          "runtimeReadPaths": ["/opt/homebrew"]
        }
      },
      "environment": {
        "allowedScopes": ["processTree"],
        "defaultScope": "processTree"
      },
      "executables": [
        {
          "executableId": "node-helper",
          "executable": {
            "kind": "hostPath",
            "path": "/opt/homebrew/bin/node"
          },
          "fixedArgs": [],
          "shell": false
        }
      ]
    }
  }
}
```

`executable` is a Host-only locator validated exclusively by the selected Backend. The Native Backend uses
`{ "kind": "hostPath", "path": "..." }`; a virtual Linux Backend may define its own guest-path, package, or
image software identity. The legacy `executablePath` is accepted only as Native-manifest compatibility input,
is removed during normalization, and cannot configure a virtual Backend.

The Service reads and freezes the manifest only at startup; apply changes through the normal Service restart lifecycle. Launch with `holonomy run --capability-runtime runtime.json ...`. Following OpenAPI `ProcessStartRequest.capabilityRuntime`, `runtime.json` supplies the complete Context, SandboxPolicy v2, initial Middleware ID, and logical `processProfileId: "developer"`. Public JSON cannot contain backend paths, mounts, credentials, or scope defaults.

The Process Policy and Host profile must have an exact executable/shell intersection. An unknown profile, unavailable Backend, unauthorized executable, cwd/env/mount/network/credential, or shell fails closed before execution; there is no fallback to ambient host `child_process`.

Experimental v86 also requires the separate Host-only `$HOLONOMY_HOME/process-backends.json` installation manifest:

```json
{
  "schemaVersion": 1,
  "backends": {
    "experimental.v86-v1": {
      "implementation": "builtin.v86-v1",
      "artifactRoot": "/opt/holonomy/v86"
    }
  }
}
```

The corresponding `process-profiles.json` uses guest paths and pins every asset digest:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "linux": {
      "profile": "process-profile-v1",
      "backend": {
        "backendId": "experimental.v86-v1",
        "configuration": {
          "artifacts": {
            "bios": { "artifactId": "seabios.bin", "sha256": "<64-hex>" },
            "kernel": { "artifactId": "kernel.bin", "sha256": "<64-hex>" },
            "initrd": { "artifactId": "agent.cpio", "sha256": "<64-hex>" },
            "wasm": { "artifactId": "v86.wasm", "sha256": "<64-hex>" }
          },
          "memoryBytes": 134217728,
          "requiredKernelCapabilities": [
            "process",
            "fuse",
            "seccompUserNotification"
          ],
          "supervisor": { "protocolVersion": 1 }
        }
      },
      "environment": {
        "allowedScopes": ["processTree"],
        "defaultScope": "processTree"
      },
      "executables": [
        {
          "executableId": "tool",
          "executable": { "kind": "guestPath", "path": "/usr/bin/tool" },
          "fixedArgs": [],
          "shell": false
        }
      ]
    }
  }
}
```

The installation manifest must be owner-only. Assets must be regular files owned by the same user, with symlinks and group/world writes rejected. Both the Service and direct Node Supervisor verify the Backend, asset IDs, digests, and profile before Guest entry; a failure does not start a generation. The CLI submits only a logical `processProfileId` and never accepts an asset directory or Backend implementation argument.

The current Process profile requires Inspector to be disabled. Backend configuration contains Host-only native paths, images, and resource bindings, and process-wide CDP cannot provide the required visibility boundary. Both the Service and direct Node Supervisor reject this combination before Guest entry.

## Pluggable Linux/WASM Backends

Every Backend reuses the same `node:child_process` facade, Broker, Process resource, Backend Registry, and Symbol scope rather than creating another public API. A Host profile selects an installed implementation by `backendId` and controls image/rootfs, mounts, network, device/system bridges, quotas, and writeback. Runtime code can request only a lifetime actually declared by that Backend descriptor; v86 currently declares `processTree` only.

Four responsibilities remain separate. Holo Process Runtime owns Node-compatible semantics. The shared Environment Host Runtime owns profiles, artifacts, environments, process/stdio resources, lifecycle, and the Capability Bridge. A Backend Driver owns boot and low-level transport only. A Guest System Adapter owns OS semantics such as paths, argv, shells, signals, process trees, and error translation. This lets v86, agentOS, and WASIX reuse most security and resource logic without exposing device, Worker, or SDK protocols through the public facade.

A v86 Host cannot directly call Linux `fork`, `execve`, `waitpid`, pipes, or signals, so its image needs one long-lived Backend Guest Agent that translates structured spawn, stdio, signal, and terminal frames into Linux Process APIs. It is not a shell or a universal component required by every Backend. The Native Backend uses host process APIs directly, while agentOS and WASIX should adapt structured process APIs already exposed by their SDKs.

The Host artifact manifest, not Runtime options, chooses software and tools in a virtual environment. Independently deliverable image layers may include `minimal` with only the Guest Agent, `base` with BusyBox and `/bin/sh`, `agent` with common tools such as `curl`, `git`, `ssh`, and `jq`, and a developer digest-bound `custom` layer. A common `imageProfile` configuration field is not frozen yet; each Backend continues to use its own Host-only manifest until that selection contract is implemented. Production assets do not contain conformance self-test fixtures.

Ordinary `spawn()` and `execFile()` directly launch an authorized executable. Only `exec()` and `spawn(..., { shell: true })` enter the shell selected by the Host profile. The shell, PATH, tool set, mounts, networking, and credentials must be explicit profile and authority inputs rather than ambient escape hatches inside the virtual environment.

### Root calls and descendant processes

Native Darwin and v86 solve different problems. A Host may install both profiles, but Runtime code cannot switch Backends by itself:

| Backend       | Executable boundary                                                  | Current root-call boundary                                                        | Current descendant boundary                                                                                                          |
| ------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Native Darwin | macOS Mach-O binaries and system tools admitted by the Host manifest | Every call first crosses Process Policy, CanonicalResource, and Cordis Middleware | A Seatbelt profile applies static constraints to the complete process tree; there is no Host callback before every descendant `exec` |
| v86 Linux     | Linux x86-32 ELF and shell tools admitted by the image manifest      | Every call first crosses the same Process pipeline                                | The upgraded image allows only the trusted Agent's initial root `execve`; later Guest `exec` and `fork`/`clone` are denied           |

v86 provides a path to deeper Linux process control, but the upgraded image does not yet open deep process trees: every Guest process-creation syscall returns `EPERM`, even when the configured total or depth limit is higher. Shell pipelines, background jobs, and tools that create threads may therefore be unavailable. v86 also cannot run macOS programs; a Host continues to select Native Darwin for macOS tools. Even without per-descendant callbacks, the Native profile still applies its precompiled filesystem, network, and system restrictions to descendants through Seatbelt. A future privileged Darwin process observation/admission integration would ship as a separate Host/System profile and could not borrow v86 evidence.

A later descriptor revision will distinguish static containment, observation-only, and pre-execution authorization. Native Darwin currently declares only static containment. The previous v86 image read a Guest's path and argv before a later `execve`/`execveat`, asked the Host for a decision, and then sent seccomp `CONTINUE`. The [Linux manual](https://man7.org/linux/man-pages/man2/seccomp_unotify.2.html) warns that the Guest can rewrite those pointer arguments between inspection and kernel execution; a later `/proc/<pid>/exe` check cannot undo code that already ran. The upgraded image therefore permits only the trusted Agent's initial `execve` using already-admitted root authority. Every later Guest `execve`/`execveat` returns `EPERM` before the kernel continues, and per-descendant execution authorization is not claimed. Reopening descendants requires both creation reservation/commit in the shared Process ledger and a kernel-enforced way to bind an immutable execution target.

This boundary remains Experimental. Image construction resolves and validates executable symlinks, startup assets are digest-bound, and a Process launch permits only one authorized `/workspace` mount, which cannot shadow `/bin`, `/sbin`, `/usr/bin`, or `/usr/sbin`. The Host-only Backend profile retains a 1–120000 ms gate deadline with a 30-second default, but the upgraded image does not convert a later Guest `exec` decision into `CONTINUE`. Node/Desktop and Android use the same C supervisor; the old operation 16/17/21 execution path is not acceptance evidence for the upgraded image.

The upgraded image passed the complete shared JavaScript Process conformance (13/13) on an Android API 35 arm64 emulator with a natural passing JUnit terminal. It covers the root shell, bidirectional FUSE files, TCP/UDP, Device/System injection, absolute/PATH/relative Guest exec denial, and timeout/Abort/stdout flow control without relaxing the single-process limit or descendant denial. The official Node Runtime `test:m35:v86:node` command also passed all 6 cases without skips, including restart cleanup and availability of later Host-admitted roots. Native claims remain limited to its `spawn`/`execFile`/controlled-shell binary cases. Emulator evidence does not establish physical-device support.

The shared Registry/SPI reserves independently packaged registration paths for each candidate. Without a Host installation manifest, an Experimental Backend does not enter the Registry or borrow evidence from another Backend:

- [v86](https://github.com/copy/v86) has an Experimental implementation wired into the production Node/Desktop Runtime, Service Host, and optional Android production module. Real Linux `6.8.12` E2E with the previous image proved supervisor/stdio/exit, the `/workspace` FUSE directory surface, TCP/UDP attributed to the actual Linux PID/PPID/start time and committed executable, DNS with TTL/rebinding protection, Host Device/System projections, descendant pre-execution allow/deny, and active process-tree cleanup across stop/restart; the upgraded image does not inherit that complete acceptance result. It still does not claim POSIX filesystem access outside `/workspace`, a 64-bit kernel, multicore, physical Android, or true VM snapshot/restore.
- [agentOS](https://github.com/rivet-dev/agentos) desktop probing verifies processes, stdio, VM FS, a Host-directory bridge, and both environment scopes. Linux-workload networking still fails and the distributed sidecar has no Android artifact, so it is not registered as a Holo Backend.
- [WASIX](https://wasix.org/docs/explanation/extensions-to-wasi) is suitable only for recompiled WASI/WASIX workloads. SDK `0.10.0` currently has a module-serialization regression on Node/V8; a compatibility version verifies stdio/exit/virtual FS but not process-tree control, termination cleanup, networking, snapshots, or an Android Host. It is not a Reference Backend.

Android `process-backend-v86` is a production source module, not a test-private Provider. An embedding Host includes the optional AAR and digest-bound assets, then supplies `AndroidV86RuntimeServicesFactory` while constructing the Runtime. A Process Policy of `none` reads no Linux assets and creates no second V8. When the Host selects `experimental.v86-v1` with `sandboxed` Process access, the factory installs the required V8 flags and validates assets and kernel capabilities. Each root child owns one VM in `processTree`; a shared `runtime` scope is rejected during Host profile admission. Runtime code performs no manual registration.

The current `agent` evidence asset set has raw `packageBytes` of about 37.9 MiB; the debug AAR grows by about 2.9 MiB compressed compared with an asset-disabled build. Embedders opt in with `-Pholonomy.v86.assetsDir=<trusted-directory>` or `HOLO_V86_ANDROID_ASSET_ROOT`. Without that setting, the AAR contains only about 53 KiB of bridge scripts plus an unavailable manifest. The asset set must contain digest-matched v86 WASM, BIOS, Holonomy FUSE/TUN kernel, production `agent` initramfs, and runtime driver.

Emulator E2E with the previous image crossed the standard `node:child_process` facade, production Runtime Kernel, Android Provider, dedicated trusted Javet/V8, and v86/Linux/supervisor. It verified stdio/exit, pre-spawn stdin, Linux-PID-attributed FUSE directory operations, TCP/UDP/DNS, Device/System projection, descendant allow/deny, and a new VM after generation restart; the upgraded image cannot inherit that complete conclusion. Android instrumentation APK launches the test, but the implementation under test comes from the production AAR. Android emulator and physical-device E2E for the upgraded image remain open. Backend failure closes current-generation resources; a normal Runtime restart creates a new VM rather than silently recovering inside the same generation.

Linux file access maps exactly one authorized `holo-fs` root to `/workspace`; other Guest mounts are rejected before launch. DNS/TCP/TLS from `curl` or `git` uses Process Network authority instead of pretending to be JS Fetch. The DNS Provider freezes a sorted, deduplicated address set, resolver generation, TTL, and evidence digest before the shared resolution challenge; transport may consume only a non-expired admitted address, and a changed set rejects the old invocation. The Holo Capability Broker middleware currently executes the secure invocation; the Cordis App owns plugin assembly, disposal, and watch reload. Moving the general invocation protocol onto Cordis must preserve the same Policy, authority, generation, and Provider re-authorization invariants. Each Experimental Backend needs its own descriptor probe, binary boundary, file/network bridge, and real E2E before it enters the default Registry.
