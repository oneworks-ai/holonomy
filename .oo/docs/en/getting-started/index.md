# Getting started

[简体中文](../../getting-started/index.md)

Choose one target for the first execution:

- [Run on Node](./run-on-node.md): no Android SDK; each Runtime uses an independent child process and restricted `vm` Context.
- [Run standalone holo](../platforms/native/index.md): a Rust-embedded V8 binary on macOS arm64, without a Node runtime dependency.
- [Run on Android](./run-on-android.md): requires an online emulator or physical device.

Node and Android use the machine-level Holonomy Service. Standalone Native `holo` currently manages one invocation directly and reuses the shared Runtime, module planner, and SandboxPolicy.

After the first run, continue with [Managed processes](../guides/manage-processes.md) and [Configure the sandbox](../guides/configure-sandbox.md).
