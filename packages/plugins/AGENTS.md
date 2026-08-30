# Runtime plugins

`packages/plugins/*` contains optional JavaScript/Cordis building blocks for Host-owned Runtime policy integrations.

- `permission/` provides the decision seam; applications own prompts, grants and persistence.
- `audit/` provides the observation seam; applications own sinks, retention and redaction beyond the safe invocation snapshot.
- Plugins may use only the public `ctx.holo` service and Cordis lifecycle. They must not import platform adapters, Host paths or Runtime internals.
- System Policy, authority validation, result snapshots and generation fencing remain Kernel responsibilities and are never replaceable plugins.

Verify changes with `pnpm build`, `pnpm typecheck`, `pnpm test:runtime`, `pnpm test:package`, `pnpm lint` and `pnpm format:check`.
