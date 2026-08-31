# Holonomy documentation

[简体中文](../index.md)

Holonomy is a platform-neutral, Node-like JavaScript Runtime for native hosts. The same CLI and Service run, test, manage, and debug JavaScript in isolated local Node child processes or Android V8 Runtimes, with explicit capability policies for network and filesystem boundaries.

## Start here

- First execution: [Run on Node](./getting-started/run-on-node.md) or [Run on Android](./getting-started/run-on-android.md)
- Check feasibility first: [Support matrix](./capabilities/support-matrix.md)
- Manage background work: [Managed processes](./guides/manage-processes.md)
- Start and clean up AVDs: [Manage Android emulators](./guides/manage-emulators.md)
- Run untrusted code safely: [Configure the sandbox](./guides/configure-sandbox.md)
- Intercept requests: [Network Mock](./guides/mock-network-requests.md)
- Inspect Sources and Network: [Debug with DevTools](./guides/debug-with-devtools.md)
- Call the control plane directly: [Service](./service/index.md) and [OpenAPI](./openapi/index.md)

## Reading levels

1. [Getting started](./getting-started/index.md) contains the shortest working paths.
2. [Guides](./guides/index.md) complete one user goal and include cleanup.
3. [Concepts](./concepts/index.md) explain CLI, Service, Process, and Generation.
4. [Capabilities](./capabilities/index.md) document current support and limits.
5. [Platforms](./platforms/index.md) describe public Node and Android differences.
6. [Reference](./reference/index.md) contains policies, rules, states, and precise limits.

## Current boundary

Capability Runtime `provider-v1` exposes controlled Filesystem, Device, Host System, and Network Providers on Node/Desktop and the Android emulator. Every Host resource still passes through SandboxPolicy, Cordis Middleware, and Provider authority. Android currently provides multiple logical V8 Runtimes in one application process; `isolatedProcess` is not implemented.

See [Known limitations](./capabilities/known-limitations.md) for the complete summary.

See [System architecture](./concepts/architecture.md) for the full module relationship and [Secure capability kernel](./concepts/capability-runtime.md) for admission and invocation order.
