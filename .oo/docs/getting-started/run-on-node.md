# 在 Node 上运行

[English](../en/getting-started/run-on-node.md)

Node target 适合在 Desktop 上运行不需要宿主 Node 权限的 JavaScript。每个 Runtime 位于独立 Node 子进程和全新 `vm` Context 中。

## 前置条件

在仓库根目录安装依赖并构建：

```sh
pnpm install
pnpm build
```

## 运行第一个程序

```sh
pnpm holonomy run examples/basic.mjs --target node
```

`--target` 必填。CLI 会自动启动或复用当前用户的 loopback Service，编译有界模块图，等待进程退出并转发 stdout/stderr。

## 运行测试

```sh
pnpm holonomy test "conformance/specs/**/*.test.mjs" \
  --target node \
  --sandbox conformance/sandbox/restricted.json \
  --reporter json
```

Fetch conformance 使用 Service 自有 loopback fixture，不依赖公网。

## 后台运行

```sh
pnpm holonomy run examples/basic.mjs --target node --detach
pnpm holonomy process list
```

保存返回的 `processId`。结束后显式停止或移除：

```sh
pnpm holonomy process stop <process-id>
pnpm holonomy process remove <process-id>
```

下一步：[管理进程](../guides/manage-processes.md) · [Node 平台说明](../platforms/node/index.md)
