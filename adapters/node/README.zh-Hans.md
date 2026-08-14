# Holonomy Node Adapter

[English](./README.md)

Node Adapter 会让每个 Holonomy Runtime 运行在独立的 Node 子进程中。子进程使用 `--experimental-vm-modules` 启动，为每个 Runtime 创建全新的 `vm` Context，启动平台无关的 Holonomy Runtime，然后只执行经过准入的会话模块图。

它面向 Holonomy CLI 与控制服务中的 Desktop/Node 宿主，提供：

- generation 绑定的启动、状态查询、规则更新、停止与重启；
- 有边界的 Runtime 日志和网络诊断事件；
- 指向准确子 Runtime 的可选 Node Inspector 地址；
- 共享的 Holonomy timers、console、Fetch、module loader 与 `node:*` 兼容模块；
- Cordis Runtime Plugin 的启动装载与 last-known-good watch replacement；
- macOS 上显式 opt-in 的 Stable `native.darwin-seatbelt-v1`，以及 Host 可安装的 Experimental `experimental.v86-v1`，共同提供受控 `node:child_process` 子集；
- 带 authority 校验、DNS 后精确地址 pin、原始 hostname SNI/证书校验、无连接池且不自动重定向的 HTTP(S) host。

新建的 Guest Context 不会获得 Node 环境中的 `process`、`require`、`Buffer` 或宿主 `fetch`。共享 Runtime 会在该 Context 内安装自己的有界 globals 和显式、冻结的 `node:*` registry。内部 Runtime 模块使用 `holonomy:///runtime/*`；用户模块保留调用方提供的绝对 URL。Adapter 会拒绝调用方替换内部 Runtime 模块图。

Service 是唯一的 SandboxPolicy 编译器。它向 Adapter 传入不可变 policy 及其 generation 绑定的编译计划；直接调用方不能替换 authority。默认计划不安装 Fetch 能力；`mockOnly` 安装共享 Fetch facade 和 mock router，但不会构造 Node HTTP Provider；只有 `restricted` 会为策略中的精确规范 origin、scheme、私网选择和配额启用 HTTP(S) host。规则 revision 仍只属于当前进程 generation。

当前目录提供的是平台 Adapter library seam。根 CLI 和 Service OpenAPI 负责用户命令、Runtime Plugin bundle、进程选择与场景发布。Process authority 不会从操作系统环境推断：Service 必须在 Runtime entry 前，用私有且仅 owner 可读的 Host manifest 解析逻辑 profile id。profile 缺失或被拒绝时，受控 facade 会 fail closed，绝不回退到 ambient `child_process`。

Host manifest、`--capability-runtime` 与 `childProcessEnvironment` Symbol 合同见公开[受控进程能力](../../.oo/docs/capabilities/process.md)。`process-profile-v1` 可引用已安装 Backend；v86 实现作为 optional dependency 接入但不携带 Linux 资产，agentOS 与 WASIX 尚未注册。

```js
import { NodeRuntimeSupervisor } from './adapters/node/src/index.mjs'

const runtime = new NodeRuntimeSupervisor()
await runtime.start(serviceCompiledSession)
await runtime.setRules({ mode: 'failClosed', rules })
await runtime.stop()
```

## 模块内验证

```sh
node --experimental-vm-modules --test adapters/node/test/*.test.mjs
```
