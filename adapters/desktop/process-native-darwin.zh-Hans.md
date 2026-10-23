# macOS 原生进程

[English](process-native-darwin.md)

独立 Rust/V8 `holo` 可以执行 Host 明确选择的 macOS 程序，不依赖 Node.js。默认仍拒绝进程访问。这是有界的 `native.darwin-seatbelt-v1` 子集，不是通用 shell 或 Linux VM。

## Host 配置

创建 `host.json`：

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

另建私有 `process-profiles.json`，执行 `chmod 600 process-profiles.json` 限制访问：

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

公开配置和进程结果只使用逻辑 profile/executable ID。原生路径和 Backend 设置属于这份仅 owner 可访问的 Host 清单。所选 profile 在入口前冻结，插件配置 watch 不会重新选择它。

创建 `index.mjs`：

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

预期先输出 `native-holo`，再输出 `shell-ok`。不会按宿主命令名或 PATH 隐式回退。这里明确选择 `/bin/bash`；macOS `/bin/sh` 可能转交另一个 executable，在严格执行规则下不能直接互换。

## 支持边界

- 复用 `spawn`、`spawnSync`、`execFile`、`execFileSync`、`exec`、`execSync`，以及二进制 stdio、精确 callback 参数、timeout、Abort 和 signal，全部进入原有 Policy/Broker/Cordis 调用链。`spawnSync` 返回二进制 stdout/stderr，此子集拒绝其 `encoding` 选项；按上例用 Buffer 解码，或对 `execFileSync`/`execSync` 设置 `encoding`。
- 只支持 `processTree` scope。当前静态 Seatbelt profile 禁止 fork 和执行另一个 executable；shell 内建命令可用，管道和任意外部 shell 命令不可用。提高深度上限不会开放后代进程。
- 这个 Native 子集要求 `network: none`、空 mounts、可写 rootfs 额度为零，不向程序桥接宿主文件、设备或网络。独立 v86 选项的证据和限制不同。
- Host 上限与 Policy 取交集。私有传输可以分块，但每次公开调用的 JSON 仍最多 1 MiB，包含 Base64 和 metadata。较大输入应拆成多次有界 write；累计 stdin 允许 16 MiB 不代表单次 write 可传 16 MiB。
- 进程和流归当前 generation 所有。close/Abort/stop/所有者断开会清理任务；Runtime 终止也会关闭独占的 Rust I/O helper，由它终止并回收任务，不依赖 Node helper。

Cordis 插件可在 Provider I/O 前拒绝 `process.program.spawn` 或 `process.shell.spawn`。`--watch` 只替换插件；修改 profile/Policy 需要新建 Runtime。这不是逐后代 syscall 回调，也不能强制抢占可信 Host 插件代码。

## Service 与验证

使用 `holonomy ... --target native` 时，按 [Native README](README.zh-Hans.md) 安装 `native-runtime.json`，并在 Service home 放置相同的 owner-only `process-profiles.json`。请求中只有 `processProfileId` 和 Process Policy 属于 Process 专用配置，常规 Context 与 `initialMiddlewareId` 仍必须提交。Service 暂存所选私有 profile，公开 DTO 不含 executable 或 sandbox 路径。外部控制面 CLI 可以使用 Node，但所选 `holo` 可执行文件和 Process I/O helper 不依赖 Node。

共享 JS conformance 覆盖 sync/callback/shell、二进制 stdin/stdout、callback 实参数量、exit/close、timeout、输出额度、Abort、signal，以及未声明 ID/环境变量拒绝。Native CLI 与真实 Service 测试还覆盖 profile 固定的插件 watch、stop 清理和强制终止 Runtime。这是 macOS arm64 证据，不等于 Windows、Android、完整 Node.js 兼容或签名发布验收。
