# Holonomy Node Adapter

[English](./README.md)

Node Adapter 会让每个 Holonomy Runtime 运行在独立的 Node 子进程中。子进程使用 `--experimental-vm-modules` 启动，为每个 Runtime 创建全新的 `vm` Context，启动平台无关的 Holonomy Runtime，然后只执行经过准入的会话模块图。

它面向 Holonomy CLI 与控制服务中的 Desktop/Node 宿主，提供：

- generation 绑定的启动、状态查询、规则更新、停止与重启；
- 有边界的 Runtime 日志和网络诊断事件；
- 指向准确子 Runtime 的可选 Node Inspector 地址；
- Node 22/V8 12.4 的逐次字符串/Wasm Native Engine Gate、Loader/Inspector 精确 Gate、一次性源码 reader 与有界 Host-only Runtime Observer；
- 共享的 Holonomy timers、console、Fetch、module loader 与 `node:*` 兼容模块；
- Cordis Runtime Plugin 的启动装载与 last-known-good watch replacement；
- macOS 上显式 opt-in 的 Stable `native.darwin-seatbelt-v1`，以及 Host 可安装的 Experimental `experimental.v86-v1`，共同提供受控 `node:child_process` 子集；
- 带 authority 校验、DNS 后精确地址 pin、原始 hostname SNI/证书校验、无连接池且不自动重定向的 HTTP(S) host。

新建的 Guest Context 不会获得 Node 环境中的 `process`、`require`、`Buffer` 或宿主 `fetch`。共享 Runtime 会在该 Context 内安装自己的有界 globals 和显式、冻结的 `node:*` registry。内部 Runtime 模块使用 `holonomy:///runtime/*`；用户模块保留调用方提供的绝对 URL。Adapter 会拒绝调用方替换内部 Runtime 模块图。

Crypto 默认不安装。可信 Host 可通过 `new NodeRuntimeSupervisor({ crypto: { enabled: true } })`，在共享 provider 完整自检通过后安装既有 `node:crypto` facade 和 `globalThis.crypto`。固定同步子集包括 SHA-1/SHA-256、HMAC-SHA256、AES-256-GCM（32 字节 key、12 字节 IV、16 字节 tag）、操作系统安全随机字节/UUID，以及原生常量时间字节比较。WebCrypto 提供 `getRandomValues` 和 `randomUUID`；不支持 `subtle`、RSA/ECDSA、PBKDF2、其他 cipher 或异步 Node crypto。共享配额继续生效，包括最多 64 个活动 context、每次 update 1 MiB、每次随机请求 64 KiB。会话数据不能启用或替换 provider；每代 child 使用全新原生 context，停止、失败与终止会撤销它们。原生 Node 对象不会进入 Guest realm。这沿用既有 child/VM 边界，不增加物理隔离承诺；根 CLI/Service 的选项接线属于后续集成。

Service 是唯一的 SandboxPolicy 编译器。它向 Adapter 传入不可变 policy 及其 generation 绑定的编译计划；直接调用方不能替换 authority。默认计划不安装 Fetch 能力；`mockOnly` 安装共享 Fetch facade 和 mock router，但不会构造 Node HTTP Provider；只有 `restricted` 会为策略中的精确规范 origin、scheme、私网选择和配额启用 HTTP(S) host。规则 revision 仍只属于当前进程 generation。

文件监听是尽力投递：若宿主不产生原生 `fs.watch` 回调，Adapter 会轮询被监听文件或目录自身的元数据，不扫描目录。此时目录事件的 `filename` 可能是 `null`，目录内既有文件的原位内容修改也可能没有事件；消费者应在收到无文件名事件后重新读取状态，不应把监听事件当成完整变更日志。

当前目录提供的是平台 Adapter library seam。根 CLI 和 Service OpenAPI 负责用户命令、Runtime Plugin bundle、进程选择与场景发布。Process authority 不会从操作系统环境推断：Service 必须在 Runtime entry 前，用私有且仅 owner 可读的 Host manifest 解析逻辑 profile id。profile 缺失或被拒绝时，受控 facade 会 fail closed，绝不回退到 ambient `child_process`。

Host manifest、`--capability-runtime` 与 `childProcessEnvironment` Symbol 合同见公开[受控进程能力](../../.oo/docs/capabilities/process.md)。`process-profile-v1` 可引用已安装 Backend；v86 实现作为 optional dependency 接入但不携带 Linux 资产，agentOS 与 WASIX 尚未注册。

受控字符串/Wasm 模式会强制加载与当前 Node/V8 ABI 匹配的窄 addon；缺失或加载失败会在 Guest entry 前拒绝整代 Runtime，不会静默放开代码生成。源码仓库可用 `pnpm run build:m4:node-hook` 构建当前平台 addon；发布物同时携带 addon 源码，预构建 ABI 矩阵完成前不宣称跨平台二进制即装即用。

```js
import { NodeRuntimeSupervisor } from './adapters/node/src/index.mjs'

const runtime = new NodeRuntimeSupervisor()
await runtime.start(serviceCompiledSession)
await runtime.setRules({ mode: 'failClosed', rules })
await runtime.stop()
```

Node FS Provider 在 macOS/Linux 上另用内置 N-API `openat` 原语，相对已固定的目录句柄打开文件；用 `pnpm run build:node:filesystem-hook` 构建。它不是插件，也不属于 Engine Gate；二进制缺失时安全拒绝，不回退到路径打开。包内携带源码，尚不提供即装即用的预构建二进制。这仅是 Node Adapter 的要求；独立 Rust `holo` 使用自身 OS 适配，不依赖 Node 或此 addon。

同一固定文件系统 addon 也提供有界、基于 FD 的时间、权限检查与目录原语。目录快照和同步通过共享资源生命周期持有打开时的目录对象，不重新打开被替换的路径。这些原语仅供 Host 使用，不增加原生 Runtime Plugin。

## 模块内验证

```sh
pnpm run test:adapter:node
```
