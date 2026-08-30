# 受控进程能力

[English](../en/capabilities/process.md)

M3.5 发布的是一个显式 opt-in 的 Process profile，而不是宿主 `child_process` 透传。当前 Stable 组合是 macOS Node/Desktop 上的 `process-profile-v1` + `native.darwin-seatbelt-v1`。Node/Desktop 提供 Host 安装的 Experimental `experimental.v86-v1`；Android 也提供同一 Backend 的可选生产 AAR 集成，但仍保持 Experimental。两者都不随核心包默认发布 Linux 资产；agentOS 与 WASIX 仍只是候选实现。

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
          "requiredKernelCapabilities": [
            "process",
            "fuse",
            "seccompUserNotification"
          ],
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

四类职责保持分离：Holo Process Runtime 负责 Node 兼容语义；共享 Environment Host Runtime 负责 profile、资产、environment、进程/stdio resource、生命周期和 Capability Bridge；Backend Driver 只负责启动与底层通信；Guest System Adapter 负责 path、argv、shell、signal、process tree 和错误等 OS 语义。这样 v86、agentOS 与 WASIX 可以复用大部分安全和资源逻辑，而不把各自的设备、Worker 或 SDK 协议泄漏到公共 facade。

v86 的 Host 无法直接调用 Linux 内部的 `fork`、`execve`、`waitpid`、pipe 或 signal，因此镜像内需要一个长期运行的 Backend Guest Agent，把结构化 spawn、stdio、signal 和 terminal frame 转换为 Linux Process API。它不是 shell，也不是所有 Backend 都必须携带的公共组件：Native Backend 直接使用宿主进程 API，agentOS/WASIX 则优先适配自身 SDK 已提供的结构化进程接口。

虚拟环境的软件与工具由 Host 资产清单决定，不由 Runtime options 决定。可独立交付的镜像层级包括仅含 Guest Agent 的 `minimal`、增加 BusyBox 与 `/bin/sh` 的 `base`、再增加 `curl`/`git`/`ssh`/`jq` 等常见工具的 `agent`，以及开发者摘要绑定的 `custom`。当前未冻结通用 `imageProfile` 配置字段；每个 Backend 在实现该选择前仍通过自己的 Host-only manifest 声明。生产资产不包含 conformance selftest fixture。

普通 `spawn()` 与 `execFile()` 直接启动已授权 executable；`exec()` 和 `spawn(..., { shell: true })` 才进入 Host profile 指定的 shell。shell、PATH、工具集、mount、network 和 credential 都必须显式进入 profile 与 authority，不能成为虚拟环境里的 ambient 旁路。

### Root 调用与后代进程

Native Darwin 与 v86 解决的是两类不同问题，Host 可以同时安装两种 profile，但 Runtime 代码不能自行切换 Backend：

| Backend       | 可以执行的程序                                | 当前 root 调用                                                    | 当前后代进程边界                                                                                                      |
| ------------- | --------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Native Darwin | Host manifest 准入的 macOS Mach-O 与系统工具  | 每次先经过 Process Policy、CanonicalResource 与 Cordis Middleware | Seatbelt profile 对整棵进程树施加静态约束；尚不提供每次后代 `exec` 的 Host 回调                                       |
| v86 Linux     | 镜像清单准入的 Linux x86-32 ELF 与 shell 工具 | 每次先经过相同的 Process 调用链                                   | Node/Desktop 与 Android 均在后代 `execve`/受支持 `execveat` 继续前通过 Linux seccomp user-notification 执行 Host 准入 |

因此，选择 v86 可以获得更深的 Linux 后代进程控制，但不能运行 macOS 程序；需要 macOS 工具时继续选择 Native Darwin。Native profile 即使没有逐次后代回调，Seatbelt 仍会把预先编译的文件、网络和系统约束施加到后代进程。若未来接入具备系统权限的 Darwin 进程监控/执行控制能力，它会作为独立 Host/System profile 发布，不借用 v86 的证据。

后续 descriptor revision 会把后代执行能力区分为静态约束、只观察和执行前授权。当前 Native Darwin 只能声明静态约束；v86 已具备实验性的执行前授权：root process 的第一次执行使用此前已通过 Broker 的 root authority，之后继承 seccomp listener 的进程在每次 `execve` 或 `execveat` 前暂停。Guest Agent 上报 `linuxPid`、`parentLinuxPid`、绝对路径、`argv` 和 `cwd`；Host 将路径映射为 profile 中的 `executableId`，再通过 `holo:runtime.authorizeDescendantProcess` 进入同一 Policy、CanonicalResource、Middleware 和 Provider 重验链。Host 返回 allow 后内核才继续；未知 executable、Middleware deny、断连、generation 关闭或决定超时均返回 `EPERM`。

这条边界目前仍为 Experimental：绝对 `execve`、绝对 `execveat(AT_FDCWD, flags=0)` 和 PATH 解析后的清单内绝对目标可以准入；relative dirfd、`AT_EMPTY_PATH`、相对 executable 与未知目标稳定返回 `EPERM`。1–120000 ms 的 gate deadline 由 Host-only Backend profile 配置，默认 30 秒。镜像构建时解析并校验 executable symlink，启动资产受摘要绑定；Process mount 只允许一个已授权 `/workspace`，无法遮蔽 `/bin`、`/sbin`、`/usr/bin` 或 `/usr/sbin`，因此可变 executable/目标替换在 v1 fail closed。Node/Desktop 与 Android 使用同一 C supervisor 和 operation 16/17 Host channel。

真实 Node `22.22.2` / V8 `12.4` / v86 / Linux E2E 已验证 Host allow/deny、未知路径拒绝和 generation 清理。共享 Android JavaScript conformance 还从标准 facade 验证清单内绝对目标、PATH lookup 可执行、未知目标和相对目标拒绝；两端都在内核继续执行前完成 Host 决策。

共享 Registry/SPI 为不同候选保留独立打包和注册路径。没有 Host 安装清单时，Experimental Backend 不进入 Registry，也不借用其他 Backend 的测试证据：

- [v86](https://github.com/copy/v86) 的 Experimental 实现已接入正式 Node/Desktop Runtime、Service Host 与 Android 可选生产模块。真实 Linux `6.8.12` E2E 验证 supervisor/stdio/exit、`/workspace` FUSE 目录面、带 Linux PID 与 executable 上下文的 TCP/UDP/DNS、Host Device/System 投影、后代执行前 allow/deny，以及 stop/restart 前的资源清理。它仍不承诺 `/workspace` 之外的 POSIX 文件面、64-bit kernel、multicore、物理 Android 或真正的 VM snapshot/restore。
- [agentOS](https://github.com/rivet-dev/agentos) 的 Desktop probe 已验证进程、stdio、VM FS、Host 目录桥和两种 environment scope；Linux workload 的网络桥仍失败，发布 sidecar 也没有 Android 产物，因此尚未注册为 Holo Backend。
- [WASIX](https://wasix.org/docs/explanation/extensions-to-wasi) 只适合重新编译的 WASI/WASIX workload。当前 SDK `0.10.0` 在 Node/V8 存在模块序列化回归；兼容版本虽验证 stdio/exit/虚拟 FS，但 process tree、终止清理、网络、snapshot 与 Android Host 均未闭合，因此不会作为 Reference Backend。

Android 的 `process-backend-v86` 是正式源码模块，不是测试目录里的临时 Provider。嵌入方把这个可选 AAR 与摘要绑定资产装入 Host，并在创建 Runtime 时使用 `AndroidV86RuntimeServicesFactory`。当 Process Policy 为 `none` 时不读取 Linux 资产也不创建第二个 V8；当 Host 选择 `experimental.v86-v1` 且 Policy 为 `sandboxed` 时自动设置所需 V8 flags、校验资产与 kernel capability，并为每个 generation 创建 Backend。无需 Runtime 代码手动注册。

当前 `agent` 验证资产的 raw `packageBytes` 约为 37.9 MiB；Debug AAR 相比禁用资产构建增加约 2.9 MiB 压缩体积。嵌入方通过 `-Pholonomy.v86.assetsDir=<trusted-directory>` 或 `HOLO_V86_ANDROID_ASSET_ROOT` 决定是否打包；未配置时 AAR 只包含约 53 KiB 的桥接脚本和 unavailable manifest。资产集必须包含摘要匹配的 v86 WASM、BIOS、Holonomy FUSE/TUN kernel、生产 `agent` initramfs 和 runtime driver。

模拟器 E2E 已从标准 `node:child_process` facade 贯通生产 Runtime Kernel、Android Provider、独立可信 Javet/V8、v86/Linux/supervisor，并验证 stdio/退出、pre-spawn stdin、带 Linux PID 的 FUSE 目录操作、TCP/UDP/DNS、Device/System 投影、后代 allow/deny 与 generation restart。测试由 Android instrumentation APK 发起，但被测实现来自上述生产 AAR。Backend 失败会关闭当代资源；正常 Runtime restart 创建新的 VM，不在同一 generation 内静默恢复。物理设备支持仍未声明。

Linux 内的文件访问只映射一个已授权的 `holo-fs` root 到 `/workspace`；其他 Guest mount 在启动前拒绝。`curl`/`git` 的 DNS/TCP/TLS 走 Process Network authority，而不是伪装成 JS Fetch。当前安全调用由 Holo Capability Broker middleware 执行，Cordis App 负责插件装配、卸载和 watch reload；通用调用协议切换到 Cordis 后也必须保留相同的 Policy、authority、generation 与 Provider 重验不变量。每个 Experimental Backend 必须分别完成 descriptor probe、二进制边界、文件/网络桥和真实 E2E，才能进入默认 Registry。
