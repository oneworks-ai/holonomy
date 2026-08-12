# Holonomy Service

[English](../en/service/index.md)

Service 是当前用户共享的机器级常驻控制面。CLI 与 OpenAPI 客户端都通过它管理 Node、Android、设备、AVD、进程、日志、Network Rules 和 Inspector lease。

## 生命周期

```sh
pnpm holonomy service start
pnpm holonomy service status
pnpm holonomy service stop
pnpm holonomy service stop --drain
pnpm holonomy service token rotate
```

默认 Service 仅监听 loopback，并使用 owner-only 256-bit Token。非 loopback 必须配置 TLS；不开放 CORS，并校验 Host。状态默认位于 `~/.holonomy`，可以用 `HOLONOMY_HOME` 覆盖。

普通 stop 在仍有活动自有资源时返回冲突。`--drain` 只停止当前 Service 拥有的 Runtime、Inspector lease 和受管模拟器，不操作外部设备或进程。

## 持久资源

- 终态进程、日志和 mutation 结果默认保留 24 小时。
- Process 日志使用独立有界存储；SSE 只携带摘要和 cursor。
- Android forward、reverse 和 cleanup intent 持久化，daemon 恢复后按 owner/generation 重新核验。
- 设备离线时进程可以进入 `lost`，清理请求保持 pending，设备恢复后继续。

## 远程访问

显式远程模式不启动本地 Service，也不回退直接 ADB。Token 应从 `--openapi-token-file` 或 `HOLONOMY_OPENAPI_TOKEN_FILE` 读取，不能放在普通命令行参数中。

HTTP 资源见 [OpenAPI](../openapi/index.md)，CLI 用法见[管理进程](../guides/manage-processes.md)。
