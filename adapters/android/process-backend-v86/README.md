# Holonomy Android v86 Process Backend

[简体中文](./README.zh-Hans.md)

This optional Android library supplies the Experimental `experimental.v86-v1` Process Backend. Each root child owns
one trusted v86/Linux environment in the `processTree` scope; shared `runtime` VMs are currently rejected because
network packets are not yet bound to a nontransferable Linux PID. The Backend is exposed only through Holonomy's
controlled `node:child_process` facade.

Package the digest-bound assets explicitly:

```bash
./gradlew -Pholonomy.v86.assetsDir=/absolute/trusted/v86-assets :app:assembleDebug
```

The directory must contain `libv86.mjs`, `v86.wasm`, `seabios.bin`, `kernel.bin`, and `agent.cpio`. The Host then
supplies `AndroidV86RuntimeServicesFactory` to `RuntimeEngineFactory.create()`. A Process policy of `none` creates no
extra V8. A sandboxed profile selecting `experimental.v86-v1` validates the assets and required kernel capabilities
before accepting process work.

`spawn` publishes a bounded pending resource without waiting on the Runtime thread for Linux boot. Pending roots count
toward concurrency, and kill/cancel/disposal before readiness fences later execution. The Host startup timeout defaults
to 300000ms and can be configured within 1..600000ms. The process `timeout`/execution budget starts after readiness and
spawn submission, not at VM creation; use an AbortSignal for an end-to-end caller deadline. This differs from assuming
ordinary Node process-start latency. Cold boot can take minutes; no sub-120-second startup SLA is declared.

The upgraded image denies Guest fork/clone and every exec after the trusted root's initial exec. Simulator evidence must
identify the exact assets, source and startup-plus-execution test budget; the old image's descendant-admission evidence
does not apply. Physical-device acceptance remains open. This Experimental backend also does not claim synchronous
process APIs, 64-bit/multicore, or true VM snapshot/restore. See the
[process capability documentation](../../../.oo/docs/en/capabilities/process.md).
