# Runtime process API

Create with `POST /v1/processes` and an `Idempotency-Key`:

```json
{
  "deviceId": "node:local",
  "entryUrl": "app+local://workspace/main.mjs",
  "inspectorMode": "off",
  "isolation": "runtime",
  "launch": {
    "argv": [],
    "entryUrl": "app+local://workspace/main.mjs",
    "env": {},
    "moduleRootUrl": "app+local://workspace/",
    "modules": [
      {
        "source": "console.log('managed Holonomy runtime')\n",
        "url": "app+local://workspace/main.mjs"
      }
    ],
    "schemaVersion": 2,
    "target": "node"
  },
  "target": "node"
}
```

The entry URL must appear exactly once in `launch.modules`. Every module URL must remain under
`moduleRootUrl`; submit source text directly rather than a local path.

Process states are `queued → staging → starting → waiting_for_debugger|running → stopping → exited|failed|cancelled|lost`. Read operations at `/v1/operations/{id}`. Actions are `POST /v1/processes/{id}:stop|:restart|:resume` with `{ "expectedGeneration": 1 }`. Remove a terminal process with `DELETE /v1/processes/{id}` and the same generation body.
