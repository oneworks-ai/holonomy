# Capability Runtime machine contracts

This directory is the machine-readable owner for RFC-0001 contracts. It owns
strict SandboxPolicy parsing, canonical JSON/digests, closed operation and
capability registries, and shared cross-platform vectors.

- Keep this layer platform-neutral and free of Node, Android, Service, UI, and
  Provider implementations.
- Missing or unknown policy fields fail closed. Normalization may sort declared
  sets, but it must never widen authority.
- Service compiles these contracts; Runtime Broker and Providers consume the
  frozen result. Do not duplicate policy parsing in adapters.
- Tests belong under `__tests__/js-runtime-kernel/capability-runtime/`.
- Public Provider support is not inferred from a registry row; support claims
  require the milestone E2E evidence.
- Capability-specific facades, registries and Provider-neutral contracts live
  in `packages/capabilities/*/src/kernel/`; this directory owns only shared
  admission, snapshot, policy, authority, resource, delivery and lifecycle
  primitives plus their aggregate composition points.
- Host profile paths, Provider registration/configuration and platform I/O
  belong to adapters and must not enter this platform-neutral package.
