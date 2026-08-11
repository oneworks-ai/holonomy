# Inspector and CDP

Create an Inspector lease with `POST /v1/processes/{id}/inspector-leases`. The body contains `expectedGeneration` and optional `openDevTools`; admission also requires an `Idempotency-Key`.

The proxy forwards V8 `Runtime.*` and `Debugger.*`. Holonomy owns `Network.enable`, `Network.disable`, and `Network.getResponseBody`, and emits `requestWillBeSent`, `responseReceived`, `dataReceived`, and exactly one `loadingFinished` or `loadingFailed`.

Response body retention is diagnostic-only: 2 MiB per response, 16 MiB per process, 64 MiB per Service, five-minute TTL. Eviction does not change Fetch behavior. Inspector URLs and access tokens are generation-scoped secrets.
