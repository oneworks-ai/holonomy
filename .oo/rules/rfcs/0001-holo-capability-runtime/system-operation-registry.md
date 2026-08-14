# RFC-0001 附录 C.2：System Information Operation Registry

[返回 Host 系统信息投影](host-system-projection.md)

```ts
type SystemInformationOperationV1 =
  | 'system.os.arch.read'
  | 'system.os.machine.read'
  | 'system.os.platform.read'
  | 'system.os.type.read'
  | 'system.os.release.read'
  | 'system.os.version.read'
  | 'system.os.cpus.read'
  | 'system.os.parallelism.read'
  | 'system.os.memory.total.read'
  | 'system.os.memory.free.read'
  | 'system.os.uptime.read'
  | 'system.os.loadavg.read'
  | 'system.os.hostname.read'
  | 'system.os.network-interfaces.read'
  | 'system.os.user-info.read'
  | 'system.os.home-directory.read'
  | 'system.os.temp-directory.read'
  | 'system.process.pid.read'
  | 'system.process.cwd.read'
  | 'system.process.exec-path.read'
  | 'system.process.environment.read'
```

所有 row 都是 `kind=read`、`interception=host`、`invocationMode=sync`、无 callback。`node:process` property 在 initial module installation 以同一 operation 准入一次，之后只读冻结结果；它不是绕过 Broker 的 ambient property。

| Module/member                | Operation                         | Capability                   | unavailable   |
| ---------------------------- | --------------------------------- | ---------------------------- | ------------- |
| node:os/arch                 | system.os.arch.read               | host.system.basic            | throw         |
| node:os/machine              | system.os.machine.read            | host.system.version          | throw         |
| node:os/platform             | system.os.platform.read           | host.system.basic            | throw         |
| node:os/type                 | system.os.type.read               | host.system.basic            | throw         |
| node:os/release              | system.os.release.read            | host.system.version          | throw         |
| node:os/version              | system.os.version.read            | host.system.version          | throw         |
| node:os/cpus                 | system.os.cpus.read               | host.system.compute          | throw         |
| node:os/availableParallelism | system.os.parallelism.read        | host.system.compute          | throw         |
| node:os/totalmem             | system.os.memory.total.read       | host.system.memory           | throw         |
| node:os/freemem              | system.os.memory.free.read        | host.system.memory           | throw         |
| node:os/uptime               | system.os.uptime.read             | host.system.runtime          | throw         |
| node:os/loadavg              | system.os.loadavg.read            | host.system.runtime          | throw         |
| node:os/hostname             | system.os.hostname.read           | host.system.identity         | throw         |
| node:os/networkInterfaces    | system.os.network-interfaces.read | host.system.network-topology | emptyObject   |
| node:os/userInfo             | system.os.user-info.read          | host.system.identity         | throw         |
| node:os/homedir              | system.os.home-directory.read     | host.system.identity         | throw         |
| node:os/tmpdir               | system.os.temp-directory.read     | host.system.identity         | throw         |
| node:process/pid             | system.process.pid.read           | host.system.process-identity | throwOnRead   |
| node:process/cwd             | system.process.cwd.read           | host.system.process-identity | throwOnInvoke |
| node:process/execPath        | system.process.exec-path.read     | host.system.process-identity | throwOnRead   |
| node:process/env             | system.process.environment.read   | host.system.process-identity | emptyObject   |

`throw`/`throwOnRead`/`throwOnInvoke` 都生成 E.1 的 `ERR_ACCESS_DENIED`；`emptyObject` 返回冻结 null-prototype空结构，只用于上表两项。`cwd` 保持 Node 函数形态；pid/execPath/env 是 read-only projection，Guest 写入、delete和defineProperty拒绝。

参数 Schema：除 `userInfo` 仅允许省略或 `{encoding:'utf8'}` 外，所有 os function 必须零参数；未知 overload稳定 `ERR_INVALID_ARG_VALUE`。Result Schema精确使用 `SystemFieldValueMapV1` 对应 field，field→operation 映射是：row member转换到 C.1同名 key，`availableParallelism`、memory字段和process字段使用表中显式 operation。

machine vectors必须逐row校验member、field、operation、capability、mode、unavailable behavior、result schema、无callback tuple；任何System member使用`device.*` operation都稳定拒绝。
