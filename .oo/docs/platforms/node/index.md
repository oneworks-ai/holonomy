# Node/Desktop 平台

[English](../../en/platforms/node/index.md)

每个受管 Runtime 使用独立 Node 子进程、`--experimental-vm-modules` 和全新的 `vm` Context。Context 不继承宿主的 `process`、`require`、`Buffer` 或 `fetch`。

共享 Runtime 安装经过审核的 globals、Node synthetic modules、Timers、Console、Fetch 和 Network Mock。只有 `restricted` 网络策略会创建真实 Node HTTP(S) Provider；它在 DNS 授权后固定精确地址，保留原 hostname 的 TLS/SNI/证书校验，不使用连接池，也不自动跟随重定向。

Node Inspector 属于准确的子 Runtime。`--inspect-brk` 会先发布 Inspector readiness，再等待 generation-bound resume，避免 Service 启动请求被同步 debugger wait 阻塞。

Node/Desktop 可以通过 `--config holo.config.json` 在 Guest entry 前装载 Cordis Runtime Plugin；`--watch` 对配置数组做 last-known-good revision replacement。macOS 的 Stable `native.darwin-seatbelt-v1` 与 Experimental `experimental.v86-v1` 都通过私有 Host manifest 和 `--capability-runtime` 显式启用，提供同一个受控 `node:child_process` facade，但从不成为默认 CLI 权限。v86 还需要独立 `process-backends.json` 安装清单和 Host 提供的摘要绑定 Linux 资产。参见[受控进程能力](../../capabilities/process.md)。

Node Adapter 是平台接入层，不向 guest 暴露宿主 Node 权限。完整接入说明见模块 [README](../../../../adapters/node/README.zh-Hans.md)。
