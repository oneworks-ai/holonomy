# 管理 Runtime 进程

[English](../en/guides/manage-processes.md)

Holonomy 使用稳定 `processId` 管理一个逻辑进程。Restart 保持 `processId`，递增 `generation`，并创建新的 Runtime、NativeHost 和 Inspector 上下文。

## 创建

前台运行会等待终态：

```sh
pnpm holonomy run examples/basic.mjs --target node
```

后台运行立即返回进程 ID：

```sh
pnpm holonomy run examples/basic.mjs --target node --detach
```

## 观察

```sh
pnpm holonomy process list
pnpm holonomy process show <process-id>
pnpm holonomy process logs <process-id> --follow
```

日志和终态默认保留 24 小时。OpenAPI 客户端应使用日志 cursor 和 SSE `after` cursor 续传，不要把数组长度当作 cursor。

## Stop 与 Restart

```sh
pnpm holonomy process stop <process-id>
pnpm holonomy process restart <process-id>
```

OpenAPI mutation 必须携带最后观察到的 `expectedGeneration`。如果收到 409，重新读取进程；不要让旧客户端重试并误操作新 generation。

## Remove

```sh
pnpm holonomy process remove <process-id>
```

Remove 只接受终态进程，并清理该进程的日志、Network Rules、Inspector lease 和保留的 fixture lease。Service stop 在仍有活动自有资源时会拒绝；只有显式 `--drain` 才清理 Service 自己拥有的资源。

状态与转换见[Process 与 Generation](../concepts/process-and-generation.md)。
