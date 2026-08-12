# Holonomy Service

[简体中文](../../service/index.md)

The Service is the machine-level persistent control plane shared by current users. CLI and OpenAPI clients use it to manage Node, Android, devices, AVDs, processes, logs, Network Rules, and Inspector leases.

## Lifecycle

```sh
pnpm holonomy service start
pnpm holonomy service status
pnpm holonomy service stop
pnpm holonomy service stop --drain
pnpm holonomy service token rotate
```

By default, the Service listens only on loopback and uses an owner-only 256-bit Token. Non-loopback access requires TLS. CORS is disabled and Host is validated. State defaults to `~/.holonomy` and can be overridden with `HOLONOMY_HOME`.

A regular stop returns a conflict while owned active resources exist. `--drain` stops only runtimes, Inspector leases, and managed emulators owned by this Service. It does not operate on external devices or processes.

## Durable resources

- Terminal processes, logs, and mutation results are retained for 24 hours by default.
- Process logs use a separate bounded store. SSE carries only summaries and cursors.
- Android forward, reverse, and cleanup intents are persisted and revalidated by owner and generation after daemon recovery.
- A process may become `lost` while its device is offline. Cleanup remains pending and resumes when the device returns.

## Remote access

Explicit remote mode does not start a local Service and never falls back to direct ADB. Read the Token from `--openapi-token-file` or `HOLONOMY_OPENAPI_TOKEN_FILE`; do not place it in an ordinary command-line argument.

See [OpenAPI](../openapi/index.md) for HTTP resources and [Manage processes](../guides/manage-processes.md) for CLI usage.
