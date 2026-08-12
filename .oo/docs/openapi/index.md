# OpenAPI

[English](../en/openapi/index.md)

Service 在 `/openapi.json` 发布 OpenAPI 3.1 文档。本文只解释资源模型；请求和响应字段以运行中服务的 Schema 为准。

## 资源

| 资源          | 主要路径                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Service       | `/healthz`、`/v1/service`、`/v1/service:shutdown`                                                                           |
| Devices       | `/v1/devices`、`/v1/devices:refresh`                                                                                        |
| Emulators     | `/v1/emulators`、`/v1/emulators/{id}:start`、`/v1/emulators/{id}:stop`、`/v1/emulators/{id}:restart`                        |
| Processes     | `/v1/processes`、`/v1/processes/{id}`、`/v1/processes/{id}:stop`、`/v1/processes/{id}:restart`、`/v1/processes/{id}:resume` |
| Logs/Events   | `/v1/processes/{id}/logs`、`/v1/processes/{id}/events`、`/v1/events`                                                        |
| Network Rules | `/v1/processes/{id}/network/rules`                                                                                          |
| Inspector     | `/v1/processes/{id}/inspector-leases`                                                                                       |
| Operations    | `/v1/operations/{id}`                                                                                                       |
| Skills        | `/.oo/skills/index.json`、`/.oo/skills/{scenario}/SKILL.md`                                                                 |

## Mutation 规则

- 使用 Bearer Token。
- 每次 mutation 携带 `Idempotency-Key`。
- Process、Network Rules 与 Inspector 操作携带当前 `expectedGeneration`。
- Network Rules 还使用 `If-Match` revision。
- `202` 表示已准入，客户端继续读取 Operation 或 SSE，不能把它当作完成。

旧 generation 返回 409。客户端必须重新读取资源，而不是自动改用最新 generation 执行原意不明的操作。

## 事件

全局与进程 SSE 都使用单调 cursor。断线重连传最后确认的 `after`。进程日志具有独立 cursor；过滤掉其他进程事件不会改变全局事件 cursor 的含义。

完整场景可直接使用 Service 发布的四个 Skills：管理进程、调试进程、Mock 网络请求和管理模拟器。
