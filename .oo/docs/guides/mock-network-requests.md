# Mock 网络请求

[English](../en/guides/mock-network-requests.md)

Network Mock 是进程级、声明式且有 revision 的规则集。它不执行脚本、正则、模板、文件或 shell。

## 启动前安装

```sh
pnpm holonomy run examples/debuggable.mjs \
  --target node \
  --sandbox ./sandbox.json \
  --network-rules ./rules.json
```

初始规则会在入口模块执行前原子安装，因此入口的第一个 Fetch 不会越过 Mock。

## 运行中替换

通过 `PUT /v1/processes/{id}/network/rules` 提交完整规则集，并携带：

- `Idempotency-Key`
- 当前 `expectedGeneration`
- 当前 `If-Match` revision

新 revision 只影响随后准入的 exchange；已经开始的请求继续使用旧快照。并发冲突时重新读取并显式协调，不能无条件覆盖。

## 验证

可以读取进程日志，或建立 Inspector lease 后在 Network 面板确认：

- method 与 canonical URL
- response status
- `real` 或 `mock` 来源
- 唯一 terminal 事件
- 配额内 response body

规则上限和 matcher 见 [Network Rule Schema](../reference/network-rule-schema.md)。
