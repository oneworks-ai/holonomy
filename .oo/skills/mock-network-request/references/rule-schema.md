# Network rule schema

Each rule has `id`, integer `priority`, `match`, `action`, and optional `lifetime`. Higher priority wins; equal priority uses creation order; first match wins.

`match` supports uppercase method, canonical origin, path `exact|prefix`, query/header `exact|subset` with repeated entries and absent names, and body `empty|utf8|base64|json|jsonSubset|sha256`. Large bodies use SHA-256. Sensitive headers support only the `<present>` sentinel, an absent-name condition, or a `sha256:<64-lowercase-hex>` value; plaintext values are rejected.

`action.type` is `respond`, `fail`, or `passthrough`. Responses, delays, and chunks are bounded. The rule-set `mode` is `passthrough` or `failClosed`.

```json
{
  "expectedGeneration": 1,
  "mode": "failClosed",
  "rules": [{
    "id": "create-item",
    "priority": 100,
    "match": {
      "method": "POST",
      "origin": "https://api.example",
      "path": { "op": "exact", "value": "/v1/items" },
      "query": { "mode": "subset", "entries": [["tag", "a"]] },
      "headers": {
        "mode": "subset",
        "entries": [["content-type", "application/json"]]
      },
      "body": { "kind": "jsonSubset", "value": { "name": "demo" } }
    },
    "action": {
      "type": "respond",
      "status": 201,
      "body": { "kind": "json", "value": { "id": 1 } }
    }
  }]
}
```
