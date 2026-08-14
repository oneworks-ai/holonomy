# 受控进程能力

[English](../en/capabilities/process.md)

M3.5 发布的是一个显式 opt-in 的 Process profile，而不是宿主 `child_process` 透传。当前 Stable 组合是 macOS Node/Desktop 上的 `process-profile-v1` + `native.darwin-seatbelt-v1`。Node/Desktop 还提供可由 Host 安装的 Experimental `experimental.v86-v1`；它在 Node V8 内启动受控 Linux，但镜像资产不随 npm 包默认发布。Android 当前没有生产 Process Backend，agentOS 与 WASIX 也仍只是候选实现。

## Runtime 内使用

入口保持 Node 兼容：

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

当前 facade 覆盖 `spawn`、`execFile`、`exec` 及三个同步入口，并提供受控 stdin/stdout/stderr、pause/resume、signal、timeout、AbortSignal 和有界输出。程序名是 Host manifest 中的 `executableId`，不会执行 PATH lookup，也不能传入宿主绝对路径。

`pause()`只暂停向 Runtime 代码投递，不会暂停 Host 对 stdout/stderr 的读取和计量；暂停期间超过输出上限仍会终止完整 process tree。`maxConcurrentProcesses`、`maxTotalProcesses`与`maxOpenPipes`同样由Host强制执行，同步入口也计入总进程数。

`childProcessEnvironment` 使用 Symbol，避免占用 Node options 的字符串字段。省略时使用 Host 默认值；Runtime 内代码只能请求 Host 已允许的 scope。当前 native Backend 只声明 `processTree`，所以每次 root child 与 descendants 都在同一受控生命周期内，并在 close、stop 或 restart 时清理。支持长驻环境的 Backend 可以由 Host 开放 `runtime`，Guest 仍不能选择 Backend、镜像、mount、network 或 credential。

## Host 配置

原生路径只存在于 Service 私有 manifest，而不进入 Runtime 启动 JSON。默认路径是 `$HOLONOMY_HOME/process-profiles.json`；未设置 `HOLONOMY_HOME` 时为 `~/.holonomy/process-profiles.json`。文件必须是普通文件、非符号链接且仅 owner 可读写，例如：

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

`executable` 是由所选 Backend 独占校验的 Host-only locator。Native Backend 使用
`{ "kind": "hostPath", "path": "..." }`；虚拟 Linux Backend 可以使用自己的 guest path、package
或 image 内软件 identity。旧的 `executablePath` 只作为 Native manifest 兼容输入读取，规范化后不会保留，也不能用于虚拟 Backend。

Service 只在启动时读取并冻结 manifest；修改后需要通过正常 Service 生命周期重启。启动侧使用 `holonomy run --capability-runtime runtime.json ...`，其中 `runtime.json` 按 OpenAPI `ProcessStartRequest.capabilityRuntime` 提交完整 Context、SandboxPolicy v2、初始 Middleware ID 和逻辑 `processProfileId: "developer"`。公开 JSON 不接受 backend 路径、mount、credential 或 scope 默认值。

Process Policy 与 Host profile 的 executable/shell 集合必须精确相交。未知 profile、Backend 不可用、未授权 executable、cwd/env/mount/network/credential 或 shell 都在执行前 fail closed；不会回退到宿主 `child_process`。

Experimental v86 还需要一个独立的 Host-only 安装清单 `$HOLONOMY_HOME/process-backends.json`：

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

对应 `process-profiles.json` 使用 guest path，并逐个冻结资产摘要：

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

安装清单本身必须仅 owner 可读写；资产必须是同一 owner 的普通文件，禁止符号链接和 group/world write。Service 与直接 Node Supervisor 都会在 Guest entry 前校验 Backend、资产 ID、摘要与 profile；失败时 generation 不启动。CLI 只提交逻辑 `processProfileId`，不接受资产目录或 Backend implementation 参数。

当前 Process profile 必须关闭 Inspector。Backend 配置含 Host-only 原生路径、镜像和资源绑定，进程级 CDP 无法提供满足该隔离要求的可见性边界；Service 与直接 Node Supervisor 都会在 Guest entry 前拒绝二者同时开启。

## 可插拔 Linux/WASM Backend

所有 Backend 复用同一个 `node:child_process` facade、Broker、Process resource、Backend Registry 和 Symbol scope，不会再造第二套公开 API。Host profile 通过 `backendId` 选择已安装实现，并控制 image/rootfs、mount、network、device/system bridge、配额和 writeback；Runtime 内代码只选择被允许的 `runtime` 或 `processTree` 生命周期。

共享 Registry/SPI 为不同候选保留独立打包和注册路径。没有 Host 安装清单时，Experimental Backend 不进入 Registry，也不借用其他 Backend 的测试证据：

- [v86](https://github.com/copy/v86) 的 Node/Desktop Experimental 实现现已接入正式 Node Runtime 与 Service Host 配置。Node `22.22.2` / V8 `12.4` E2E 在标准 `node:child_process` facade 后真实启动 Linux `6.8.12`，同时验证 supervisor/stdio/exit、经 Capability Broker 的 FUSE 文件读写、带 Linux PID 与 executable 上下文的精确授权 HTTP，以及 stop 前的资源清理。它仍不支持任意 TCP/UDP/DNS、完整 FS surface、64-bit kernel 或 multicore。
- [agentOS](https://github.com/rivet-dev/agentos) 的 Desktop probe 已验证进程、stdio、VM FS、Host 目录桥和两种 environment scope；Linux workload 的网络桥仍失败，发布 sidecar 也没有 Android 产物，因此尚未注册为 Holo Backend。
- [WASIX](https://wasix.org/docs/explanation/extensions-to-wasi) 只适合重新编译的 WASI/WASIX workload。当前 SDK `0.10.0` 在 Node/V8 存在模块序列化回归；兼容版本虽验证 stdio/exit/虚拟 FS，但 process tree、终止清理、网络、snapshot 与 Android Host 均未闭合，因此不会作为 Reference Backend。

Android 模拟器中的 Javet/V8 已真实启动 v86、Linux 和同一 supervisor。一个 trusted Backend E2E
运行实例内同时验证了进程/stdio/退出、FUSE request/response，以及经生产 Capability Runtime 和
`AndroidCapabilityHost` 执行的归因文件读写。随后启动的第二个 Linux 进程发出 HTTP 请求；Host 以
Linux PID、synthetic process 和 executable 为上下文完成 `process.network.connect` 授权，再访问精确
允许的 loopback endpoint。该实现仍只属于 instrumentation 证据，未装入 Android 默认 Backend
Registry；它也不代表任意 TCP/UDP/DNS 已实现。物理设备不是当前实验轨道的强制门槛，未来发布物理设备
支持声明时再单独验收。

Linux 内的文件访问必须映射已授权的 `holo-fs` root；`curl`/`git` 的 DNS/TCP/TLS 走 Process
Network authority，而不是伪装成 JS Fetch。当前安全调用由 Holo Capability Broker middleware 执行，
Cordis App 负责插件装配、卸载和 watch reload；通用调用协议切换到 Cordis 后也必须保留相同的
Policy、authority、generation 与 Provider 重验不变量。每个 Experimental Backend 必须分别完成
descriptor probe、二进制边界、文件/网络桥和真实 E2E，才能进入默认 Registry。
