# Holonomy Android v86 Process Backend

[English](./README.md)

这个可选 Android library 提供 Experimental `experimental.v86-v1` Process Backend。当前每个 root child
在 `processTree` scope 独占一个可信 v86/Linux 环境；网络包尚未携带不可转移的 Linux PID 绑定，因此共享
`runtime` VM 会被拒绝。Backend 只通过 Holonomy 受控的 `node:child_process` facade 暴露。

必须显式打包摘要绑定资产：

```bash
./gradlew -Pholonomy.v86.assetsDir=/absolute/trusted/v86-assets :app:assembleDebug
```

目录必须包含 `libv86.mjs`、`v86.wasm`、`seabios.bin`、`kernel.bin` 和 `agent.cpio`。Host 随后把
`AndroidV86RuntimeServicesFactory` 传给 `RuntimeEngineFactory.create()`。Process Policy 为 `none` 时不会
创建额外 V8；sandboxed profile 选择 `experimental.v86-v1` 后，会先校验资产与必需 kernel capability，
再接受进程调用。

`spawn` 会先发布有界 pending 资源，不在 Runtime 线程等待 Linux 冷启动；pending 计入并发配额，ready 前
kill/cancel/dispose 会阻止迟到执行。Host 启动超时缺省 300000ms，可在 1..600000ms 内配置。进程的
`timeout`/执行预算从 ready 后提交 spawn 起算，不包含 VM 创建；端到端截止请使用 AbortSignal。不能据普通
Node 进程启动延迟来理解这一路径，冷启动可能需要数分钟，当前不声明低于 120 秒的启动 SLA。

升级镜像拒绝 Guest fork/clone 和受信任 root 首次执行之后的所有 exec。模拟器证据必须绑定实际资产、源码
和“启动加执行”测试预算，不能沿用旧镜像的后代执行前准入结果；物理设备验收仍未完成。该 Experimental
Backend 也不声明同步进程 API、64-bit/multicore 或真正的 VM snapshot/restore。详见
[受控进程能力](../../../.oo/docs/capabilities/process.md)。
