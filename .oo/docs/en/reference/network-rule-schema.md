# Network Rule Schema

[简体中文](../../reference/network-rule-schema.md)

A rule set is a replace-all resource:

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

## Match conditions

- method: exact uppercase match.
- origin: canonical origin.
- path: `exact` or `prefix`.
- query/header: `exact` or `subset`, preserving duplicate keys and supporting `absent`.
- body: `empty`, `utf8`, `base64`, `json`, `jsonSubset`, or `sha256`.

## Actions

- `respond`: status 200–599, headers, bounded body, delay, and chunks.
- `fail`: `connection_refused`, `timeout`, or `unavailable`.
- `passthrough`: enters the real provider only when SandboxPolicy and rule-set mode both allow it.

## Limits and ordering

- At most 256 rules and at most 1 MiB of serialized rule-set data.
- Descending priority; creation order within the same priority; first match wins.
- Lifetime supports `maxMatches` and `expiresAt`.
- Sensitive headers never accept or echo plaintext. Use presence/absence or `sha256:<hex>`.
- Regular expressions, scripts, templates, files, and shell commands are unsupported.

A live replacement must include `If-Match`, `Idempotency-Key`, and `expectedGeneration`.
