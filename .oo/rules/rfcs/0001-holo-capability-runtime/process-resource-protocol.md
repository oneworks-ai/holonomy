# RFC-0001 附录 J.2：ChildProcess Resource 与 stdio Protocol

[返回 Process Operation Registry](process-operation-registry.md)

本附录是 `ChildProcessFacadeV1`、resource events 和 `pipe` stdio 的规范性 owner。它只描述 Guest façade delivery；Host/Linux fd、PID、native stream和backing buffer永不跨Realm。

## J.2.1 Facade types

```ts
type ProcessSignalV1 = 'SIGTERM' | 'SIGKILL' | 'SIGINT'

interface ChildProcessStdinFacadeV1 {
  write(
    data: FsDataV1,
    callback?: (error: NodeErrorSnapshotV1 | null) => void
  ): boolean
  end(callback?: (error: NodeErrorSnapshotV1 | null) => void): this
  destroy(): this
}

type ChildProcessStdinEventV1 =
  | Readonly<{
    event: 'callback'
    callbackId: number
    error: NodeErrorSnapshotV1 | null
  }>
  | Readonly<{ event: 'close' }>

type ChildProcessReadableEventV1 =
  | Readonly<{ event: 'data'; tuple: readonly [RuntimeBufferV1] }>
  | Readonly<{ event: 'end'; tuple: readonly [] }>
  | Readonly<{ event: 'error'; tuple: readonly [NodeErrorSnapshotV1] }>
  | Readonly<{ event: 'close'; tuple: readonly [] }>

interface ChildProcessReadableFacadeV1 {
  on(event: 'data', listener: (chunk: RuntimeBufferV1) => void): this
  on(event: 'end' | 'close', listener: () => void): this
  on(event: 'error', listener: (error: NodeErrorSnapshotV1) => void): this
  pause(): this
  resume(): this
  destroy(): this
}

interface ChildProcessFacadeV1 {
  readonly pid: number
  readonly stdin: ChildProcessStdinFacadeV1 | null
  readonly stdout: ChildProcessReadableFacadeV1 | null
  readonly stderr: ChildProcessReadableFacadeV1 | null
  kill(signal?: ProcessSignalV1): boolean
  on(event: 'spawn', listener: () => void): this
  on(event: 'error', listener: (error: NodeErrorSnapshotV1) => void): this
  on(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: ProcessSignalV1 | null) => void
  ): this
}
```

`ProcessSpawnOptionsV1.stdio`只能省略或是精确三元组`[stdin,stdout,stderr]`，省略默认`['pipe','pipe','pipe']`；缺项、多项、sparse slot和其他值在snapshot阶段拒绝。每个slot按已准入的`pipe|ignore`创建：`pipe`返回对应facade，`ignore`返回null。v1不支持inherit、IPC、arbitrary fd、TTY、encoding mutation或把Guest object当stream。Guest `pid` 是generation-local synthetic identifier，不是Host/Linux PID。

## J.2.2 Process event state

```ts
type ChildProcessEventV1 =
  | Readonly<{ event: 'spawn'; tuple: readonly [] }>
  | Readonly<{ event: 'error'; tuple: readonly [NodeErrorSnapshotV1] }>
  | Readonly<{
    event: 'exit'
    tuple: readonly [number | null, ProcessSignalV1 | null]
  }>
  | Readonly<{
    event: 'close'
    tuple: readonly [number | null, ProcessSignalV1 | null]
  }>

interface ChildProcessResourceStateV1 {
  readonly resourceId: string
  readonly generation: number
  readonly state: 'starting' | 'running' | 'exited' | 'closed'
  readonly spawnDelivered: boolean
  readonly errorCount: 0 | 1
  readonly exitDelivered: boolean
  readonly closeDelivered: boolean
}
```

成功start允许`spawn → exit → close`；spawn失败为`error → close`且没有spawn/exit。运行后Provider failure可产生一次error，但仍必须最终`exit → close`。ChildProcess `close`在process terminal且所有pipe close后exactly once；从未spawn时可无exit。stop、timeout、Abort、disconnect和restart收敛到同一状态机，late generation event全部丢弃。

## J.2.3 stdio delivery 与 backpressure

stdout/stderr每个pipe拥有独立generation-bound queue、sequence和byte counter。Provider chunk先在Host复制/计量，再以`RuntimeBufferV1`复制进Guest；单chunk和累计bytes不得超过`ProcessLimitsV2`。正常顺序是零或多个data→end→close；失败是零或多个data→error→close且无end。end/error互斥，各至多一次，close exactly once。listener throw/slow不阻塞Provider；队满或stdout/stderr cap触发E.1 `resource.byte_limit`、终止完整process tree、对应stream error→close和ChildProcess error/exit/close。

`.on(...)`只把Guest listener登记在既有readable facade上，不独立获取authority；真正的Host→Guest事件泵由J.1 `stdout/stderr events` systemOnly row和`ProcessReadableEventDeliveryV1`拥有，绑定同一ProcessInstance、generation、stream kind与queue/byte limits。Host Middleware不能匹配该delivery。

`pause()`只暂停Guest delivery，不暂停Host计量；有界queue满仍按output cap失败，不能无限缓存。`resume()`按sequence继续，不能重放已投递chunk。`destroy()`撤销该reader、清queue并close，不扩大process authority。Abort/stop/restart清空未交付bytes并使旧facade stale。

stdin `write()`先做data snapshot和quota reservation，同步返回backpressure boolean；接受的write callback必须绑定原生stream的write terminal并异步exactly once，成功`callback(null)`、失败`callback(error)`。`end()`立即返回同一个stdin facade，但callback必须等待原生end/flush terminal；不得在Host调用返回时提前合成成功。Runtime为每个在途callback分配generation-bound、Host-only的正整数callback id；Provider以`ChildProcessStdinEventV1`交付对应terminal，Guest只收到最终Node callback参数。

重复end/destroy幂等；terminal后write稳定`ERR_INVALID_STATE`且不接触Provider。`end`是write/systemOnly，只启动优雅terminal，不提前释放binding；真正的resource terminal由Host stdin close事件拥有。stdin close或generation/resource close必须同步以稳定错误结算仍在途的callback，然后exactly-once交付close并fence后续native terminal。pause/resume/end/destroy使用J.1的systemOnly Registry row和同一个ProcessInstance binding，不能ambient调用Provider。callback省略不改变admission或错误状态。输入quota触发`EFBIG`；捕获输出超限触发`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`，两者不得退化为通用`EIO`。

## J.2.4 Machine vectors

vectors覆盖三种stdio slot的pipe/ignore投影、stdin native write/end terminal、callback `arguments.length===1`及null/error、write boolean/backpressure、terminal后write不触达Provider、close结算在途callback、stdout/stderr data copy与sequence、pause queue cap、正常end→close、error→close、output cap同时终止process、listener throw、destroy/Abort/restart late event。checker必须拒绝缺失stdout/stderr字段、未声明event schema、stdin callback非`Error|null`或resource event terminal漂移。
