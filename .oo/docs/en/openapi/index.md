# OpenAPI

[简体中文](../../openapi/index.md)

The Service publishes an OpenAPI 3.1 document at `/openapi.json`. This page explains the resource model; the running Service schema is authoritative for request and response fields.

## Resources

| Resource      | Main paths                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Service       | `/healthz`, `/v1/service`, `/v1/service:shutdown`                                                                           |
| Devices       | `/v1/devices`, `/v1/devices:refresh`                                                                                        |
| Emulators     | `/v1/emulators`, `/v1/emulators/{id}:start`, `/v1/emulators/{id}:stop`, `/v1/emulators/{id}:restart`                        |
| Processes     | `/v1/processes`, `/v1/processes/{id}`, `/v1/processes/{id}:stop`, `/v1/processes/{id}:restart`, `/v1/processes/{id}:resume` |
| Logs/Events   | `/v1/processes/{id}/logs`, `/v1/processes/{id}/events`, `/v1/events`                                                        |
| Network Rules | `/v1/processes/{id}/network/rules`                                                                                          |
| Inspector     | `/v1/processes/{id}/inspector-leases`                                                                                       |
| Operations    | `/v1/operations/{id}`                                                                                                       |
| Skills        | `/.oo/skills/index.json`, `/.oo/skills/{scenario}/SKILL.md`                                                                 |

## Mutation rules

- Authenticate with the Bearer Token.
- Send an `Idempotency-Key` with every mutation.
- Send the current `expectedGeneration` with Process, Network Rules, and Inspector operations.
- Network Rules also use an `If-Match` revision.
- `202` means admitted. Continue reading the Operation or SSE; do not treat admission as completion.

An old generation returns 409. A client must reread the resource instead of silently applying an ambiguous old intent to the latest generation.

## Events

Global and process SSE use monotonic cursors. Reconnect with the last acknowledged `after` value. Process logs use a separate cursor. Filtering other process events does not change the meaning of the global event cursor.

For complete scenarios, use the four Skills published by the Service: manage runtime processes, debug runtime processes, mock network requests, and manage emulators.
