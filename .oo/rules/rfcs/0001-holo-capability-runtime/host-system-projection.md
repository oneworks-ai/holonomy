# RFC-0001 附录 C：Host 系统信息投影

[返回 RFC 总览](../0001-holo-capability-runtime.md)

`node:os` 与受支持的 `node:process` 身份字段不能固定为真实或固定合成。可信 Host 在创建 generation 时逐字段提供冻结投影；Guest facade 不直接调用 ambient Node/OS API。

## C.1 字段与模式

```ts
type SystemInformationFieldV1 =
  | 'os.arch'
  | 'os.machine'
  | 'os.platform'
  | 'os.type'
  | 'os.release'
  | 'os.version'
  | 'os.cpus'
  | 'os.availableParallelism'
  | 'os.totalmem'
  | 'os.freemem'
  | 'os.uptime'
  | 'os.loadavg'
  | 'os.hostname'
  | 'os.networkInterfaces'
  | 'os.userInfo'
  | 'os.homedir'
  | 'os.tmpdir'
  | 'process.pid'
  | 'process.cwd'
  | 'process.execPath'
  | 'process.env'

type SystemProjectionModeV1 =
  | 'real'
  | 'synthetic'
  | 'redacted'
  | 'unavailable'

type SystemExposedProjectionModeV1 = Exclude<
  SystemProjectionModeV1,
  'unavailable'
>

type HostSystemFieldProjectionV1<K extends SystemInformationFieldV1> =
  | Readonly<{
    mode: 'real' | 'synthetic'
    precision: 'exact' | 'coarse'
    value: SystemFieldValueMapV1[K]
  }>
  | Readonly<{
    mode: 'redacted'
    precision: 'redacted'
    value: SystemFieldValueMapV1[K]
  }>
  | Readonly<{
    mode: 'unavailable'
    precision: 'none'
  }>

interface HostSystemProjectionV1 {
  readonly schemaVersion: 1
  readonly fields: {
    readonly [K in SystemInformationFieldV1]?: HostSystemFieldProjectionV1<K>
  }
}
```

`SystemFieldValueMapV1` 的 Node 兼容形状、范围和限额由[附录 C.1](host-system-value-types.md)冻结。未知字段拒绝。缺失字段等于 `unavailable/none`。判别联合严格拒绝 unavailable+value、redacted+exact及real/synthetic+redacted；unavailable不读取宿主。

## C.2 字段级规则

| 字段组                     | exact 风险 | coarse/redacted 规则                         | capability                     |
| -------------------------- | ---------- | -------------------------------------------- | ------------------------------ |
| arch/platform/type         | 低         | 可归一为 `unknown`                           | `host.system.basic`            |
| release/version/machine    | 中         | major family 或 `unknown`                    | `host.system.version`          |
| cpus/parallelism           | 中         | 只给数量与 bucket，不给型号                  | `host.system.compute`          |
| totalmem/freemem           | 中         | 2 的幂 bucket，freemem 可省略                | `host.system.memory`           |
| uptime/loadavg             | 中         | 时间/负载 bucket                             | `host.system.runtime`          |
| hostname/userInfo/home/tmp | 高         | 合成虚拟身份/路径或 unavailable              | `host.system.identity`         |
| networkInterfaces          | 高         | 只给 transport/count，地址默认移除           | `host.system.network-topology` |
| pid/cwd/execPath/env       | 高         | Runtime 虚拟值、allowlist env 或 unavailable | `host.system.process-identity` |

真实 hostname、用户名、原生路径、PID、环境变量和接口地址必须同时满足 Policy 字段 ceiling、Capability 和 Host projection；Context 的 generic JSON 投影不能替代该 authority。

precision 信息量偏序固定为 `redacted < coarse < exact`。Policy 的 `maxPrecision` 是上限：requested/result precision 的 rank 不得更高；`real` source 也可以被 Policy 强制粗化。粗化算法只使用附录 C.1 的确定变换，平台不能自行选择。

## C.3 Facade 行为

- `node:os` 函数每次仍进入 Broker，读取 generation-bound snapshot，并允许 Host Middleware 按 operation 拦截。
- `node:process` 的稳定属性在 Synthetic Module 安装时通过初始 Middleware 准入一次；需要逐次授权的数据不得暴露成静态属性。
- `unavailable` 对函数抛 Node-compatible `ERR_ACCESS_DENIED`；对可选对象成员返回规范定义的空结构。不得偷偷回退 ambient OS。
- `redacted` 返回类型保持值，并在内部结果 metadata 标记 redacted；Guest 不依赖非标准 metadata。
- Host restart 可以产生新 projection；同 generation 内不可变，旧 facade 由 generation fencing 失效。

Provider 只消费冻结 snapshot，不保留 Host `os`/`process` 对象引用。Host/Guest/Inspector Context 不会自动获得 system projection；Inspector 只有在独立 inspector projection 明确复制时才能看到其 Guest-safe 子集。

每个member的module/member、`SystemInformationOperationV1`、capability、unavailable行为和initial property准入由[附录 C.2](system-operation-registry.md)唯一冻结。本节字段分组不生成operation；System operation不得使用`device.*`命名。

## C.4 固定测试

共享 machine schema/vectors 必须逐字段证明：默认不泄漏；四种 mode 的结果稳定；自定义 synthetic 生效；real 需要显式 Policy+Capability；wrong type、unknown key、overflow 和非法 precision 拒绝；coarse/redacted 变换确定；真实 path/PID/env 不进错误、日志或 CDP；restart 更新 projection；Host Context 中同名字段不能覆盖 system projection。
