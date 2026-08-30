# RFC-0001 附录 J：`node:child_process` 与可选 Linux Backend

[返回 RFC 总览](../0001-holo-capability-runtime.md)

本附录冻结受控进程能力的 profile 合同；实际支持只按公开矩阵中通过真实 E2E 的 Backend 声明。旧的受限 Git command facade 不属于本合同，也不能据此创建任意 OS/Linux 进程。Node 已有该 API，因此 Guest 入口必须是 `node:child_process`，不得另造 `holo:process`。Runtime、Provider 与 Policy 只能由可信 Android/Desktop/Service Host 在 Guest entry 前创建和冻结。

## J.1 SandboxPolicy

```ts
type ProcessSandboxV2 =
  | { readonly access: 'none' }
  | {
    readonly access: 'sandboxed'
    readonly executables: readonly ProcessExecutablePolicyV2[]
    readonly shell: ProcessShellPolicyV2
    readonly mounts: readonly ProcessMountPolicyV2[]
    readonly network: ProcessNetworkPolicyV2
    readonly environment: ProcessEnvironmentPolicyV2
    readonly limits: ProcessLimitsV2
  }

interface ProcessExecutablePolicyV2 {
  readonly executableId: string
  readonly argumentBytes: number
}
type ProcessShellPolicyV2 =
  | { readonly access: 'none' }
  | { readonly access: 'restricted'; readonly executableId: string }
interface ProcessMountPolicyV2 {
  readonly rootId: string
  readonly guestPath: string
  readonly rights: readonly ('read' | 'write')[]
}
type ProcessNetworkPolicyV2 =
  | { readonly access: 'none' }
  | {
    readonly access: 'restricted'
    readonly endpoints: readonly ProcessNetworkEndpointV2[]
    readonly maxSockets: number
  }
interface ProcessNetworkEndpointV2 {
  readonly transport: 'tcp' | 'tls' | 'udp'
  readonly hostname: string
  readonly ports: readonly number[]
}
interface ProcessEnvironmentPolicyV2 {
  readonly allowedNames: readonly string[]
  readonly maxValueBytes: number
}
interface ProcessLimitsV2 {
  readonly maxConcurrentProcesses: number
  readonly maxTotalProcesses: number
  readonly maxProcessTreeDepth: number
  readonly maxExecutionTimeMs: number
  readonly maxStdinBytes: number
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
  readonly maxOpenPipes: number
  readonly maxWritableRootfsBytes: number
}
```

`executableId` 是 Host manifest 中的稳定逻辑 ID（如 `git`、`ssh`、`bash`），不是 Guest 提供的宿主路径。Provider 在创建 generation 时把 ID 解析为已验证的 Backend executable；PATH lookup、绝对 Host path、`DYLD_*`/`LD_*`、credential value 和未知环境变量默认拒绝。`exec()`及`spawn(...,{shell:true})`必须额外满足`shell`分支；普通`spawn`/`execFile`不得经过shell。

mount只引用已被`FilesystemSandboxV2`准入的rootId，effective rights取FS rights与mount rights交集。Process网络是独立authority；它不能复用Fetch的HTTP Provider或因Runtime允许Fetch就自动放行任意socket。DNS解析后的每个address、redirect/代理目标和新socket都由Backend按同一endpoint authority重验。credential只通过generation-bound fd/agent/askpass opaque binding注入，永不进入argv/env/log。

## J.2 Capability 与资源

```ts
interface ProcessExecutionCapabilityConstraintsV1 {
  readonly executableIds: readonly string[]
  readonly rootIds: readonly string[]
  readonly limits: ProcessLimitsV2
}
interface ProcessShellCapabilityConstraintsV1 {
  readonly executableIds: readonly string[]
}
interface ProcessSignalCapabilityConstraintsV1 {
  readonly signals: readonly ('SIGTERM' | 'SIGKILL' | 'SIGINT')[]
}
interface ProcessNetworkCapabilityConstraintsV1 {
  readonly endpoints: readonly ProcessNetworkEndpointV2[]
  readonly maxSockets: number
}
interface ProcessExecutableResourceBaseV1 extends CanonicalResourceBaseV1 {
  readonly kind: 'processExecutable'
  readonly cwdSemanticResourceDigest?: string
  readonly environmentScope: 'runtime' | 'processTree'
  readonly environmentNamesDigest: string
  readonly stdioDigest: string
}
type ProcessExecutableResourceV1 =
  | (ProcessExecutableResourceBaseV1 & {
    readonly invocation: 'program'
    readonly executableId: string
    readonly argvDigest: string
  })
  | (ProcessExecutableResourceBaseV1 & {
    readonly invocation: 'shell'
    readonly shellExecutableId: string
    readonly commandDigest: string
  })
interface ProcessInstanceResourceV1 extends CanonicalResourceBaseV1 {
  readonly kind: 'processInstance'
  readonly executableSemanticResourceDigest: string
  readonly processResourceId: string
  readonly generation: number
}
```

系统 canonicalizer在Middleware前冻结program executableId+ordered argv digest，或shell executableId+exact command digest；两种分支带不同type tag。它还冻结Host准入后的environment scope、virtual cwd identity、环境名称集合与stdio mode；display只显示脱敏命令标签。Provider使用同一binding，不重新把原始字符串解释成授权。Linux PID、Host PID、native path、credential、完整敏感argv和command不进入Guest/CDP/公开错误。

## J.3 Operation Registry 与 Node facade

逐export/overload Registry、ChildProcess resource event状态机、callback tuple、stdio composite delivery、resource canonicalizer和limits由[附录 J.1](process-operation-registry.md)唯一冻结。`node:child_process`错误只能由附录E.1的`CAPABILITY_ERROR_MAP_V1`生成；本说明章节不重复维护错误选择。

## J.4 Host、Engine、Backend、System 与 Host profile

Host Platform、JavaScript Engine、Environment Backend 与 Guest System 是四个独立组合轴：Host 描述 Runtime 位于哪里及如何取得原生资源，Engine 描述 Realm/模块/microtask/Inspector/Gate，Backend 描述在哪里及如何创建进程环境，System 描述 path/argv/shell/signal/process tree 等 OS 语义。`desktop` 不等于 Node 或 V8；不得再用“Android Disabled”表达 Process 支持，只能声明某个具体组合是否安装了满足 profile 的 Adapter 与 Backend。v1 `platforms` 字段只声明 Backend 的 Host 可装配范围，不替代 Engine/System 的真实支持证据。

```ts
interface ProcessBackendDescriptorV1 {
  readonly backendId: string
  readonly version: 1
  readonly family: 'native' | 'virtual-machine' | 'virtual-kernel' | 'wasix'
  readonly stability: 'stable' | 'experimental'
  readonly platforms: readonly ('node' | 'desktop' | 'android')[]
  readonly binaryFormats:
    readonly ('host-native' | 'linux-x86-32' | 'packaged-wasm' | 'wasix')[]
  readonly environmentScopes: readonly ('runtime' | 'processTree')[]
  readonly features: {
    readonly filesystemBridge: boolean
    readonly networkBridge: boolean
    readonly pty: boolean
    readonly shell: boolean
    readonly signals: boolean
    readonly snapshots: boolean
    readonly synchronousSpawn: boolean
  }
}
```

Descriptor由Backend实现发布并通过共享machine schema校验，不是Host手写的支持声明。Host profile使用`process-profile-v1`，只引用已安装的`backendId`并携带由该Backend独占校验的Host-only configuration；未知Backend、配置校验失败或平台不匹配必须在Guest entry前失败。共享Environment Host Runtime拥有profile/asset/environment、Process/stdio resource、生命周期与Capability Bridge；Backend Driver只拥有启动和底层transport，Guest System Adapter拥有OS语义。Backend native path、image/rootfs、软件包、mount实现和密钥不得进入Guest、CDP、公开DTO或错误。Backend候选保持不同语义，不得互相伪装：

| Backend family             | 目标用途                                     | 二进制边界                      |
| -------------------------- | -------------------------------------------- | ------------------------------- |
| `native`                   | 受控宿主进程；首个Stable实现为macOS Seatbelt | Host manifest中的原生可执行文件 |
| `virtual-machine` / v86    | 完整32位x86 Linux VM、可长驻或每树隔离       | Linux x86-32 `elf`              |
| `virtual-kernel` / agentOS | 轻量虚拟进程、文件、管道、PTY和网络栈        | Backend打包的WASM工具           |
| `wasix`                    | Wasmer/WASIX进程与网络能力                   | 重新编译的WASI/WASIX模块        |

v86、agentOS与WASIX预留通过同一Backend SPI接入；只有实现被目标发布物真实安装并完成descriptor probe和E2E后，Host profile才可选择且支持矩阵才可声明该组合。候选名称不得出现在已安装Backend artifact中冒充实现。WASIX不宣称执行普通Linux `elf`；agentOS不宣称启动传统Linux kernel；v86不宣称x86-64或多核。Windows必须有独立Host/System Adapter处理`CreateProcess` quoting、`cmd.exe`、drive/UNC、HANDLE/pipe、Job Object、signal与错误映射；这些差异不得进入v86 Driver或公共facade。Desktop未来可装配Embedded V8、JSC、QuickJS等Engine，但未通过对应Engine Adapter与E2E前不得声明支持。

```text
Host Runtime Factory
  -> resolve Host/Engine adapters + Backend/System descriptors
  -> resolve one Host profile
  -> freeze Policy + Middleware + Provider + Backend binding
  -> start Runtime
Guest node:child_process
  -> Broker -> Holo Process Runtime -> Process Backend SPI
  -> Environment Host Runtime -> Backend Driver + Guest System Adapter
```

Host profile拥有environment的全部默认值与硬上限，包括默认scope、允许scope、Backend、rootfs/image、mount、network、device/system bridge、配额和writeback。Guest只能用Holo扩展Symbol请求允许的environment lifetime，不能在Node options里直接填写这些Host细节：

```ts
import { childProcessEnvironment } from 'holo:runtime'
import { spawn } from 'node:child_process'

declare module 'holo:runtime' {
  export const childProcessEnvironment: unique symbol
}

declare module 'node:child_process' {
  interface SpawnOptions {
    readonly [childProcessEnvironment]?: {
      readonly scope: 'runtime' | 'processTree'
    }
  }
}

spawn('git', ['status'], {
  [childProcessEnvironment]: { scope: 'processTree' }
})
```

`scope='runtime'`复用当前Runtime generation拥有的长驻environment；`scope='processTree'`为本次root child及其descendants创建独立environment，并在process tree终止后销毁。Native Backend可以只声明`processTree`。省略Symbol时使用Host默认；请求不在Descriptor与Host profile交集内时稳定拒绝，不允许回退到权限更大的scope。Symbol identity由`holo:runtime`合成模块拥有，不进入JSON snapshot；系统层只把规范化后的`environmentScope`写入Process Invocation snapshot。该scope同时进入semantic digest和Provider二次复核。

公开Node facade接受标准`timeout`与`maxBuffer`并在可信快照层分别映射为内部`timeoutMs`与`maxBufferBytes`；Host-only `shellExecutableId`、backend、mount和credential字段不得成为Guest options。同步、callback和resource-event入口都使用同一已规范化Process invocation。

虚拟Linux文件只能来自Host批准的`holo-fs` root binding。mount映射、snapshot/live一致性与writeback策略属于Host profile，Guest通常只看到`/workspace`等Linux路径；Linux read/write仍携带environmentId、synthetic process id、executableId、operation和canonical file resource进入统一Cordis Middleware，再由Backend以fd/handle方式重验。Host path永不进入Linux argv、Guest、日志或授权UI。

`curl`、`git`和包管理器的DNS/TCP/TLS不复用Fetch实现，但使用同一个Network Policy owner。Middleware上下文必须区分`network.fetch.request`与Backend内部socket continuation，并为后者提供Runtime/generation、environment scope/id、synthetic process id、executableId、destination和resolved address evidence；该continuation要求`host.process.network`authority，Backend在connect前重验endpoint。Host设备/系统能力不自动伪装成Linux`/proc`或ambient设备，只有Host profile显式提供的通用Holo bridge可见。bridge内命令名（包括`hoholo`候选名）不在本RFC冻结，另由CLI/DX设计决定。

## J.5 Backend 安全边界与固定验收

Backend实现、镜像和软件清单可以独立打包，但都必须使用同一个ProcessProvider SPI、CanonicalResource、Broker、authority、quota和generation fencing。虚拟Linux Backend若声明后代执行前授权，必须在不可绕过的kernel gate暂停后代`execve`，把generation/environment、PID/PPID、绝对path、argv与cwd的可信快照绑定到`process.program.spawn`子准入；Host只能把清单内exact executable映射为`executableId`，并在Policy、Host Middleware与Provider重验全部允许后签发一次性继续决定。未知path、timeout、disconnect、stop/restart、旧generation或late response必须fail closed且不得执行目标；root第一次`execve`可消费此前已完成的root spawn authority。`stop`/`restart`/disconnect终止对应environment的完整process tree，撤销mount/network/credential binding并拒绝late output。VM crash只能终止对应environment并产生稳定Process terminal，不能留下半失效mount/socket；run loop、block I/O和timer不能阻塞Guest JavaScript turn。

M3.5至少需要一个目标平台上的Stable真实Backend通过完整E2E；Experimental Backend不阻塞核心里程碑，但不得借用Stable Backend证据。公共测试至少覆盖Descriptor/Host profile准入、entry前binding、spawn/execFile/exec与sync feature detection、shell separation、argv/env/cwd/mount/network/credential拒绝、stdio backpressure/output cap、timeout/abort/signal、process-tree cleanup、restart fencing、Backend missing和runtime/processTree scope隔离。虚拟Backend另需覆盖crash、scheduler、文件桥、socket来源、snapshot/writeback和镜像/软件manifest；每个平台只声明自己真实执行过的Backend组合。
