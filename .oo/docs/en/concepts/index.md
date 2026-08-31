# Concepts

[简体中文](../../concepts/index.md)

- [System architecture](./architecture.md): how four composition axes, two execution planes, the shared Runtime Kernel, and the control plane connect.
- [Secure capability kernel](./capability-runtime.md): how Context, Policy, Middleware, and Providers form a non-bypassable invocation pipeline.
- [Runtime plugins and live reload](./runtime-plugins.md): Cordis plugins, `holo-plugins:///` resources, cross-platform static loading, and Node/Desktop CLI watch.
- [Runtime milestones](./milestones.md): completion boundaries and next steps for M2, M2.5, M3, M3.5, and M4.
- [Service and CLI](./service-and-cli.md): long-lived ownership and why the CLI does not directly own ADB.
- [Process and Generation](./process-and-generation.md): stable process identity and replaceable Runtime instances.

These pages explain the public model. Internal thread, protocol, and provider invariants remain in the nearest `AGENTS.md`.
