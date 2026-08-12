# Service and CLI

[简体中文](../../concepts/service-and-cli.md)

The CLI is the compilation and interaction entry point; the Service is the long-lived control plane.

```mermaid
sequenceDiagram
  actor User
  participant CLI as Holonomy CLI
  participant Service as Holonomy Service
  participant Store as State and log store
  participant Adapter as Node / Android Adapter

  User->>CLI: run / test / process command
  CLI->>CLI: Read entry and build bounded module graph
  CLI->>Service: Submit launch snapshot + SandboxPolicy
  Service->>Store: Persist Process and Operation
  Service->>Adapter: Stage and start exact generation
  Adapter-->>Service: state / output / diagnostics
  Service->>Store: Advance cursors and terminal state
  Service-->>CLI: Operation, SSE, or log page
  CLI-->>User: output, report, or processId
```

The CLI reads commands, discovers entries, builds a bounded module graph, generates test wrappers, and renders results. The Service owns devices, processes, logs, fixtures, ADB leases, Network Rules, Inspector leases, recovery, and retention.

Default `--openapi auto` starts or reuses the current user's loopback Service. An explicit remote Service never falls back to local or direct ADB; non-loopback access requires HTTPS and a token.

Single ownership prevents concurrent CLIs from deleting one another's forward, reverse, or session resources and allows detached processes to outlive their creating CLI.
