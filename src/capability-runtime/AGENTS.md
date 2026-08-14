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
- `guest-child-process-*` owns the public Node-compatible facade, the
  `childProcessEnvironment` Symbol option, and Guest resource reconstruction.
  `process-backend.ts` owns only the platform-neutral descriptor schema and
  shared vectors. Host profile paths, Backend registration/configuration, and
  process execution belong to platform adapters and must not enter this
  platform-neutral package.
