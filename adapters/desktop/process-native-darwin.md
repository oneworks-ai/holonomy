# Native macOS processes

[简体中文](process-native-darwin.zh-Hans.md)

The standalone Rust/V8 `holo` can run Host-selected macOS executables without Node.js. Process access remains denied by default. This is the bounded `native.darwin-seatbelt-v1` subset, not a general-purpose shell or Linux VM.

## Host configuration

Create `host.json`:

```json
{
  "schemaVersion": 1,
  "processProfileId": "developer",
  "sandboxPolicy": {
    "schemaVersion": 2,
    "process": {
      "access": "sandboxed",
      "executables": [
        { "executableId": "echo", "argumentBytes": 4096 },
        { "executableId": "shell", "argumentBytes": 4096 }
      ],
      "shell": { "access": "restricted", "executableId": "shell" },
      "environment": { "allowedNames": [], "maxValueBytes": 1024 },
      "mounts": [],
      "network": { "access": "none" },
      "limits": {
        "maxConcurrentProcesses": 2,
        "maxTotalProcesses": 16,
        "maxProcessTreeDepth": 1,
        "maxOpenPipes": 6,
        "maxExecutionTimeMs": 5000,
        "maxStdinBytes": 65536,
        "maxStdoutBytes": 65536,
        "maxStderrBytes": 65536,
        "maxWritableRootfsBytes": 0
      }
    }
  }
}
```

Create the separate private `process-profiles.json` and restrict it with `chmod 600 process-profiles.json`:

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
          "runtimeReadPaths": []
        }
      },
      "executables": [
        {
          "executableId": "echo",
          "executable": { "kind": "hostPath", "path": "/bin/echo" },
          "fixedArgs": [],
          "shell": false
        },
        {
          "executableId": "shell",
          "executable": { "kind": "hostPath", "path": "/bin/bash" },
          "fixedArgs": [],
          "shell": true
        }
      ],
      "defaultShellExecutableId": "shell",
      "environment": {
        "allowedScopes": ["processTree"],
        "defaultScope": "processTree"
      }
    }
  }
}
```

Only the logical profile/executable IDs appear in public configuration and process results. Native paths and backend settings belong to this owner-only Host manifest. Its selected profile is frozen before entry, including across plugin configuration watch.

Create `index.mjs`:

```js
import { execSync, spawnSync } from 'node:child_process'

const result = spawnSync('echo', ['native-holo'])
if (result.error) throw result.error
console.log(result.stdout.toString('utf8').trim())
console.log(execSync('printf shell-ok', { encoding: 'utf8' }))
```

```sh
holo --host-config ./host.json --process-profiles ./process-profiles.json ./index.mjs
```

Expected output is `native-holo` followed by `shell-ok`. No ambient executable-name or PATH fallback is used. `/bin/bash` is selected explicitly; macOS `/bin/sh` may dispatch through a different executable and is not interchangeable under the strict executable rule.

## Supported boundary

- Shared `spawn`, `spawnSync`, `execFile`, `execFileSync`, `exec` and `execSync` facades, binary stdio, exact callback tuples, timeout, Abort and signals use the existing Policy/Broker/Cordis pipeline. `spawnSync` returns binary stdout/stderr; this subset rejects its `encoding` option. Use Buffer decoding as above, or `execFileSync`/`execSync` with `encoding`.
- Only `processTree` scope is available. The current static Seatbelt profile denies fork and execution of another executable; shell builtins work, but pipelines and arbitrary external shell commands do not. A larger depth ceiling does not enable descendants.
- This Native subset requires `network: none`, empty mounts and zero writable rootfs budget. It does not bridge host files, devices or network into a workload. The independent v86 option has different evidence and restrictions.
- Host limits and Policy intersect. The private transport can chunk stdin, but each public invocation JSON is still bounded to 1 MiB, including Base64 and metadata. Send large input as multiple bounded writes; a 16 MiB aggregate stdin allowance is not a 16 MiB single-write guarantee.
- Process and stream resources belong to their generation. Close/Abort/stop/owner disconnection dispose jobs; Runtime termination also closes the owned Rust I/O helper, which kills and reaps its jobs. There is no Node helper dependency.

Cordis plugins may deny `process.program.spawn` or `process.shell.spawn` before Provider I/O. `--watch` replaces only plugins: profile/Policy changes require a new Runtime. This does not provide a callback before every descendant syscall or hard preemption of trusted Host plugin code.

## Service and validation

For `holonomy ... --target native`, install `native-runtime.json` as described in the [Native README](README.md), and place the same owner-only manifest at the Service home's `process-profiles.json`. The only Process-specific request fields are `processProfileId` and the Process Policy; the normal Context and `initialMiddlewareId` are still required. The Service stages the selected private profile; public DTOs do not contain executable or sandbox paths. The external control-plane CLI may use Node; the selected `holo` executable and Process I/O helper do not.

The shared JS conformance covers sync/callback/shell, binary stdin/stdout, callback arity, exit/close, timeout, output cap, Abort, signals and undeclared-ID/environment denial. Native CLI and real Service tests additionally cover profile-stable plugin watch, stop cleanup and forced Runtime termination. This is macOS arm64 evidence, not Windows, Android, complete Node.js compatibility or signed-release acceptance.
