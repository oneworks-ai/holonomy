# Holonomy Android v86 Process Backend

[English](./README.md)

这个可选 Android library 提供 Experimental `experimental.v86-v1` Process Backend。它为每个 Runtime
generation 创建一个可信 v86/Linux 环境，并且只通过 Holonomy 受控的 `node:child_process` facade 暴露。

必须显式打包摘要绑定资产：

```bash
./gradlew -Pholonomy.v86.assetsDir=/absolute/trusted/v86-assets :app:assembleDebug
```

目录必须包含 `libv86.mjs`、`v86.wasm`、`seabios.bin`、`kernel.bin` 和 `supervisor.cpio`。Host 随后把
`AndroidV86RuntimeServicesFactory` 传给 `RuntimeEngineFactory.create()`。Process Policy 为 `none` 时不会
创建额外 V8；sandboxed profile 选择 `experimental.v86-v1` 后，会先校验资产与必需 kernel capability，
再接受进程调用。

当前模拟器证据覆盖异步程序执行、pre-spawn stdin、stdio/退出、带 Linux PID 归因的 `/workspace` FUSE
目录操作、TCP/UDP/DNS、Host Device/System 投影、后代执行前准入及 generation restart。该 Experimental
Backend 尚未声明同步进程 API、物理设备一致性、64-bit/multicore 或真正的 VM snapshot/restore。详见
[受控进程能力](../../../.oo/docs/capabilities/process.md)。
