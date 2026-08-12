# Network Rule Schema

[English](../en/reference/network-rule-schema.md)

规则集是完整替换资源：

```json
{
  "mode": "failClosed",
  "rules": [
    {
      "id": "profile",
      "priority": 100,
      "match": {
        "method": "GET",
        "origin": "https://api.example.com",
        "path": { "op": "exact", "value": "/profile" },
        "query": {
          "mode": "subset",
          "entries": [["source", "test"]],
          "absent": ["debug"]
        }
      },
      "action": {
        "type": "respond",
        "status": 200,
        "headers": [["content-type", "application/json"]],
        "body": { "kind": "json", "value": { "ok": true } }
      },
      "lifetime": { "maxMatches": 1 }
    }
  ]
}
```

## 匹配条件

- method：大写精确匹配。
- origin：canonical origin。
- path：`exact` 或 `prefix`。
- query/header：`exact` 或 `subset`，保留重复键，并支持 `absent`。
- body：`empty`、`utf8`、`base64`、`json`、`jsonSubset`、`sha256`。

## Action

- `respond`：200–599 status、headers、有界 body、delay 和 chunks。
- `fail`：`connection_refused`、`timeout` 或 `unavailable`。
- `passthrough`：仅在 SandboxPolicy 与规则集模式允许时进入真实 Provider。

## 限制与顺序

- 最多 256 条规则，序列化规则集不超过 1 MiB。
- priority 降序；同 priority 按创建顺序；first match wins。
- lifetime 支持 `maxMatches` 与 `expiresAt`。
- 敏感 header 不接受或回显明文；使用 presence/absence 或 `sha256:<hex>`。
- 不支持正则、脚本、模板、文件和 shell。

运行中替换必须携带 `If-Match`、`Idempotency-Key` 与 `expectedGeneration`。
