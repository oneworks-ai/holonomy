# Holonomy Android v86 Process Backend

[简体中文](./README.zh-Hans.md)

This optional Android library supplies the Experimental `experimental.v86-v1` Process Backend. It runs one trusted
v86/Linux environment per Runtime generation and exposes it only through Holonomy's controlled `node:child_process`
facade.

Package the digest-bound assets explicitly:

```bash
./gradlew -Pholonomy.v86.assetsDir=/absolute/trusted/v86-assets :app:assembleDebug
```

The directory must contain `libv86.mjs`, `v86.wasm`, `seabios.bin`, `kernel.bin`, and `agent.cpio`. The Host then
supplies `AndroidV86RuntimeServicesFactory` to `RuntimeEngineFactory.create()`. A Process policy of `none` creates no
extra V8. A sandboxed profile selecting `experimental.v86-v1` validates the assets and required kernel capabilities
before accepting process work.

The current emulator evidence covers async program execution, pre-spawn stdin, stdio/exit, Linux-PID-attributed
`/workspace` FUSE directory operations, TCP/UDP/DNS, Host Device/System projections, descendant pre-execution
admission, and generation restart. This Experimental backend does not claim synchronous process APIs,
physical-device conformance, 64-bit/multicore, or true VM snapshot/restore. See the
[process capability documentation](../../../.oo/docs/en/capabilities/process.md).
