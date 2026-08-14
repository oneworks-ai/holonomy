# Controlled process capability

[简体中文](../../capabilities/process.md)

M3.5 publishes one explicit opt-in Process profile, not a passthrough to host `child_process`. The current Stable combination is `process-profile-v1` with `native.darwin-seatbelt-v1` on macOS Node/Desktop. Node/Desktop also provides the Host-installable Experimental `experimental.v86-v1`, which boots controlled Linux inside Node V8 without shipping image assets in the default npm package. Android has no production Process Backend yet, and agentOS plus WASIX remain candidates.

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

`childProcessEnvironment` is a Symbol so it does not consume a string field in Node options. Omitting it selects the Host default, and Runtime code can request only a Host-allowed scope. The current native Backend declares only `processTree`: a root child and its descendants share one controlled lifetime and are cleaned up on close, stop, or restart. A persistent Backend can let the Host enable `runtime`; Runtime code still cannot choose a Backend, image, mount, network, or credential.

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
            "initrd": { "artifactId": "supervisor.cpio", "sha256": "<64-hex>" },
            "wasm": { "artifactId": "v86.wasm", "sha256": "<64-hex>" }
          },
          "memoryBytes": 134217728,
          "requiredKernelCapabilities": ["process", "fuse"],
          "supervisor": { "protocolVersion": 1 }
        }
      },
      "environment": {
        "allowedScopes": ["processTree", "runtime"],
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

Every Backend reuses the same `node:child_process` facade, Broker, Process resource, Backend Registry, and Symbol scope rather than creating another public API. A Host profile selects an installed implementation by `backendId` and controls image/rootfs, mounts, network, device/system bridges, quotas, and writeback. Runtime code selects only an allowed `runtime` or `processTree` lifetime.

The shared Registry/SPI reserves independently packaged registration paths for each candidate. Without a Host installation manifest, an Experimental Backend does not enter the Registry or borrow evidence from another Backend:

- [v86](https://github.com/copy/v86) now has a Node/Desktop Experimental implementation wired into the production Node Runtime and Service Host configuration. A Node `22.22.2` / V8 `12.4` E2E reaches real Linux `6.8.12` through the standard `node:child_process` facade and verifies supervisor/stdio/exit, Capability-Broker FUSE I/O, exactly authorized HTTP carrying Linux PID and executable context, and resource cleanup before stop. Arbitrary TCP/UDP/DNS, the complete FS surface, a 64-bit kernel, and multicore remain unsupported.
- [agentOS](https://github.com/rivet-dev/agentos) desktop probing verifies processes, stdio, VM FS, a Host-directory bridge, and both environment scopes. Linux-workload networking still fails and the distributed sidecar has no Android artifact, so it is not registered as a Holo Backend.
- [WASIX](https://wasix.org/docs/explanation/extensions-to-wasi) is suitable only for recompiled WASI/WASIX workloads. SDK `0.10.0` currently has a module-serialization regression on Node/V8; a compatibility version verifies stdio/exit/virtual FS but not process-tree control, termination cleanup, networking, snapshots, or an Android Host. It is not a Reference Backend.

Javet/V8 on the Android emulator has also booted v86, Linux, and the same supervisor. One trusted-Backend E2E runtime
now verifies process/stdio/exit, FUSE request/response, and attributed filesystem I/O through the production Capability
Runtime and `AndroidCapabilityHost`. A second Linux process then issues an HTTP request; the Host authorizes
`process.network.connect` with Linux PID, synthetic-process, and executable context before accessing an exactly
allowed loopback endpoint. This is still instrumentation evidence and is not installed in the default Android Backend
Registry. It also does not claim arbitrary TCP/UDP/DNS support. A physical device is not a gate for this experimental
track; it requires separate acceptance only before a physical-device support claim is published.

Linux file access must map an authorized `holo-fs` root. DNS/TCP/TLS from `curl` or `git` uses Process Network
authority instead of pretending to be JS Fetch. The Holo Capability Broker middleware currently executes the secure
invocation; the Cordis App owns plugin assembly, disposal, and watch reload. Moving the general invocation protocol
onto Cordis must preserve the same Policy, authority, generation, and Provider re-authorization invariants. Each
Experimental Backend needs its own descriptor probe, binary boundary, file/network bridge, and real E2E before it
enters the default Registry.
