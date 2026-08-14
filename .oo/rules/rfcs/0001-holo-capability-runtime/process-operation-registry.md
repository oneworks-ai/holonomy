# RFC-0001 附录 J.1：`node:child_process` Operation Registry

[返回 Process 与 Linux Backend](process-and-linux-backend.md)

本附录是 `node:child_process` façade、ChildProcess resource protocol 和 process error 映射的规范性 machine owner。未列出的 overload、option、event 和 stdio mode 稳定 `ERR_METHOD_NOT_IMPLEMENTED`，不得 ambient fallback。

## J.1.1 Closed operations 与 Schema

```ts
type ProcessOperationV1 =
  | 'process.program.spawn'
  | 'process.shell.spawn'
  | 'process.stdin.write'
  | 'process.stdin.end'
  | 'process.stdio.pause'
  | 'process.stdio.resume'
  | 'process.stdio.destroy'
  | 'process.signal.send'
  | 'process.wait'
  | 'process.resource.close'

type ProcessStdioEncodingV1 = 'utf8' | 'buffer'
type ProcessEnvironmentScopeV1 = 'runtime' | 'processTree'
interface ProcessSpawnOptionsV1 {
  readonly executableId: string
  readonly args?: readonly string[]
  readonly cwd?: VirtualPathV1
  readonly env?: Readonly<Record<string, string>>
  readonly shell?: false
  readonly stdio?: readonly [
    stdin: 'pipe' | 'ignore',
    stdout: 'pipe' | 'ignore',
    stderr: 'pipe' | 'ignore'
  ]
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}
interface ProcessShellOptionsV1
  extends Omit<ProcessSpawnOptionsV1, 'executableId' | 'args' | 'shell'>
{
  readonly shell: true
  readonly shellExecutableId: string
}
interface ProcessExecOptionsV1 {
  readonly cwd?: VirtualPathV1
  readonly env?: Readonly<Record<string, string>>
  readonly encoding?: ProcessStdioEncodingV1
  readonly timeoutMs?: number
  readonly maxBufferBytes?: number
  readonly signal?: AbortSignal
}
interface ProcessProgramSpawnArgsV1 {
  readonly executableId: string
  readonly environmentScope: ProcessEnvironmentScopeV1
  readonly args?: readonly string[]
  readonly options?: Omit<ProcessSpawnOptionsV1, 'executableId' | 'args'>
}
interface ProcessShellSpawnArgsV1 {
  readonly command: string
  readonly environmentScope: ProcessEnvironmentScopeV1
  readonly options: ProcessShellOptionsV1
}
interface ProcessExecFileArgsV1 {
  readonly executableId: string
  readonly environmentScope: ProcessEnvironmentScopeV1
  readonly args?: readonly string[]
  readonly options?: ProcessExecOptionsV1
}
interface ProcessExecArgsV1 {
  readonly command: string
  readonly environmentScope: ProcessEnvironmentScopeV1
  readonly options: ProcessExecOptionsV1 & {
    readonly shellExecutableId: string
  }
}
interface ProcessSyncResultV1 {
  readonly pid: number
  readonly status: number | null
  readonly signal: ProcessSignalV1 | null
  readonly stdout: string | RuntimeBufferV1
  readonly stderr: string | RuntimeBufferV1
  readonly error?: NodeErrorSnapshotV1
}
type ProcessSyncOutputV1 = string | RuntimeBufferV1
type ProcessExecSuccessTupleV1 = readonly [
  stdout: string | RuntimeBufferV1,
  stderr: string | RuntimeBufferV1
]
type ProcessExecCallbackDeliveryV1 = Readonly<{
  errorFirst: true
  success: {
    readonly kind: 'tuple'
    readonly tupleSchemaId: 'ProcessExecSuccessTupleV1'
  }
  failure: {
    readonly kind: 'errorAndTuple'
    readonly tupleSchemaId: 'ProcessExecSuccessTupleV1'
  }
}>
type ProcessStdinCallbackDeliveryV1 = Readonly<{
  errorFirst: true
  success: { readonly kind: 'void' }
  failure: { readonly kind: 'errorOnly' }
}>
type ProcessSyncDeliveryV1 = Readonly<{
  kind: 'invocation'
  invocationModes: readonly ['sync']
}>
type ProcessExecDeliveryV1 = Readonly<{
  kind: 'invocation'
  invocationModes: readonly ['callback']
  callback: ProcessExecCallbackDeliveryV1
  immediateResultSchemaId: 'ChildProcessFacadeV1'
}>
type ProcessStdinDeliveryV1 = Readonly<{
  kind: 'invocation'
  invocationModes: readonly ['callback']
  callback: ProcessStdinCallbackDeliveryV1
  immediateResultSchemaId: 'boolean'
  resourceEvents: Readonly<{
    eventSchemaId: 'ChildProcessStdinEventV1'
    terminalEvent: 'close'
  }>
}>
type ProcessStdinEndDeliveryV1 = Readonly<{
  kind: 'invocation'
  invocationModes: readonly ['callback']
  callback: ProcessStdinCallbackDeliveryV1
  immediateResultSchemaId: 'ChildProcessStdinFacadeV1'
  resourceEvents: Readonly<{
    eventSchemaId: 'ChildProcessStdinEventV1'
    terminalEvent: 'close'
  }>
}>
type ProcessEventDeliveryV1 = Readonly<{
  kind: 'resourceEvents'
  eventSchemaId: 'ChildProcessEventV1'
  terminalEvent: 'close'
}>
type ProcessReadableEventDeliveryV1 = Readonly<{
  kind: 'resourceEvents'
  eventSchemaId: 'ChildProcessReadableEventV1'
  terminalEvent: 'close'
}>
```

Guest `pid` 是 generation-local synthetic identifier；它不是 Host/Linux PID。所有 option 都是 fixed own-data snapshot，signal 是可信 opaque binding。公开Node options里的Holo Symbol在Host边界前被移除，机器Registry只接收已按Host profile冻结的`environmentScope`。env key/value、argv和stdio分别按 Policy hard cap计量；native path、PATH lookup和未知环境变量不可达。

## J.1.2 Per-export Registry

| Member / branch            | Delivery                       | Kind/layer        | Operation              | Capability requirement                         | Args → result / callback schema                                              | Resource canonicalizer                                | Limits owner            |
| -------------------------- | ------------------------------ | ----------------- | ---------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------- |
| spawn shell=false          | ProcessSyncDeliveryV1          | open/host         | process.program.spawn  | allOf(host.process.execute)                    | ProcessProgramSpawnArgsV1 → ChildProcessFacadeV1                             | ProcessExecutableResourceV1→ProcessInstanceResourceV1 | ProcessLimitsV2         |
| spawn shell=true           | ProcessSyncDeliveryV1          | open/host         | process.shell.spawn    | allOf(host.process.execute,host.process.shell) | ProcessShellSpawnArgsV1 → ChildProcessFacadeV1                               | ProcessExecutableResourceV1→ProcessInstanceResourceV1 | ProcessLimitsV2         |
| execFile                   | ProcessExecDeliveryV1          | open/host         | process.program.spawn  | allOf(host.process.execute)                    | ProcessExecFileArgsV1 → ChildProcessFacadeV1 / ProcessExecCallbackDeliveryV1 | ProcessExecutableResourceV1→ProcessInstanceResourceV1 | ProcessLimitsV2         |
| exec                       | ProcessExecDeliveryV1          | open/host         | process.shell.spawn    | allOf(host.process.execute,host.process.shell) | ProcessExecArgsV1 → ChildProcessFacadeV1 / ProcessExecCallbackDeliveryV1     | ProcessExecutableResourceV1→ProcessInstanceResourceV1 | ProcessLimitsV2         |
| spawnSync                  | ProcessSyncDeliveryV1          | invoke/host       | process.program.spawn  | allOf(host.process.execute)                    | ProcessProgramSpawnArgsV1 → ProcessSyncResultV1                              | ProcessExecutableResourceV1→ProcessInstanceResourceV1 | ProcessLimitsV2         |
| execFileSync               | ProcessSyncDeliveryV1          | invoke/host       | process.program.spawn  | allOf(host.process.execute)                    | ProcessExecFileArgsV1 → ProcessSyncOutputV1                                  | ProcessExecutableResourceV1→ProcessInstanceResourceV1 | ProcessLimitsV2         |
| execSync                   | ProcessSyncDeliveryV1          | invoke/host       | process.shell.spawn    | allOf(host.process.execute,host.process.shell) | ProcessExecArgsV1 → ProcessSyncOutputV1                                      | ProcessExecutableResourceV1→ProcessInstanceResourceV1 | ProcessLimitsV2         |
| ChildProcess.stdin.write   | ProcessStdinDeliveryV1         | write/host        | process.stdin.write    | inherited process binding                      | FsDataV1 → boolean / ProcessStdinCallbackDeliveryV1                          | ProcessInstanceResourceV1                             | stdinBytes/openPipes    |
| ChildProcess.stdin.end     | ProcessStdinEndDeliveryV1      | write/systemOnly  | process.stdin.end      | inherited process binding                      | empty → ChildProcessStdinFacadeV1 / ProcessStdinCallbackDeliveryV1           | ProcessInstanceResourceV1                             | stdin terminal          |
| ChildProcess.stdin.destroy | ProcessSyncDeliveryV1          | close/systemOnly  | process.stdio.destroy  | inherited process binding                      | empty → ChildProcessStdinFacadeV1                                            | ProcessInstanceResourceV1                             | idempotent              |
| stdout/stderr.pause        | ProcessSyncDeliveryV1          | invoke/systemOnly | process.stdio.pause    | inherited process binding                      | empty → ChildProcessReadableFacadeV1                                         | ProcessInstanceResourceV1                             | queue cap               |
| stdout/stderr.resume       | ProcessSyncDeliveryV1          | invoke/systemOnly | process.stdio.resume   | inherited process binding                      | empty → ChildProcessReadableFacadeV1                                         | ProcessInstanceResourceV1                             | sequence                |
| stdout/stderr.destroy      | ProcessSyncDeliveryV1          | close/systemOnly  | process.stdio.destroy  | inherited process binding                      | empty → ChildProcessReadableFacadeV1                                         | ProcessInstanceResourceV1                             | idempotent              |
| ChildProcess.kill          | ProcessSyncDeliveryV1          | invoke/host       | process.signal.send    | allOf(host.process.signal)+binding             | ProcessSignalV1? → boolean                                                   | ProcessInstanceResourceV1                             | allowed signals         |
| ChildProcess events        | ProcessEventDeliveryV1         | subscribe/system  | process.wait           | inherited process binding                      | ChildProcessResourceStateV1 → ChildProcessEventV1                            | ProcessInstanceResourceV1                             | stdout/stderr/event cap |
| stdout/stderr events       | ProcessReadableEventDeliveryV1 | subscribe/system  | process.wait           | inherited process binding                      | ChildProcessReadableFacadeV1 → ChildProcessReadableEventV1                   | ProcessInstanceResourceV1                             | stdout/stderr/queue cap |
| ChildProcess finalizer     | ProcessSyncDeliveryV1          | close/systemOnly  | process.resource.close | inherited process binding                      | empty → void                                                                 | ProcessInstanceResourceV1                             | idempotent              |

`execFile`/`exec` 的`FacadeDeliveryV1`是`immediateResultSchemaId='ChildProcessFacadeV1'`加`ProcessExecCallbackDeliveryV1`：调用立即返回ChildProcess；成功精确调用`(null, stdout, stderr)`，失败精确调用`(error, stdout, stderr)`。捕获到的stdout/stderr仍按encoding返回。`stdin.write`同理立即返回backpressure boolean；`stdin.end`立即返回同一个stdin facade。两者的callback都由同一stdin resource上的`ChildProcessStdinEventV1`异步交付，绑定Host原生write/finish terminal，而不是Runtime自行合成成功。Host-only callback id只用于关联在途terminal，不进入Guest、Policy、Middleware、日志或Grant key。它们是基础contract明确表示的composite delivery，不是prose例外，也不创建第二次Broker invocation。

`spawnSync`/`execFileSync`与`execSync`只在 Provider descriptor声明支持时安装；否则member存在但稳定抛`ERR_METHOD_NOT_IMPLEMENTED`。`fork`、IPC、detached、inherit、arbitrary fd、uid/gid和Host terminal继承在v1不可达。

## J.1.3 ChildProcess resource protocol

ChildProcess的stdin/stdout/stderr facade、`spawn/error/exit/close`状态机、stream data/end/error/close、backpressure、Abort和generation fencing由[附录 J.2](process-resource-protocol.md)唯一冻结。`ProcessEventDeliveryV1`实例化基础`FacadeDeliveryV1.resourceEvents`，不能标成callback invocation。

Backend内部socket另需`host.process.network`和exact endpoint authority；它不是Guest operation row，不能复用Fetch/Network Mock authority，也不能绕过Process Provider的DNS resolution challenge。

## J.1.4 Resource identity 与 error owner

`ProcessExecutableResourceV1` canonicalizer按闭合分支使用冻结的`program/executableId/argvDigest`或`shell/shellExecutableId/commandDigest`，再加入environmentScope、cwdSemanticResourceDigest、environmentNamesDigest和stdioDigest；`ProcessInstanceResourceV1`使用parent executable semantic digest、processResourceId和generation。完整formula由附录B拥有。每row的Node错误只从E.1 `CAPABILITY_ERROR_MAP_V1` child_process family生成；本附录不维护自由文本code选择。

machine vectors逐row比较member/branch、mode、kind/layer、operation、capability requirement、args/result/callback、resource canonicalizer和limits；另覆盖exec三实参callback、stdin immediate+callback、spawn failure、运行后error、exit/close顺序、输出cap、旧generation和未知overload。已知但错误的capability/mode/interception/tuple/resource必须使`rfc:check`失败。
