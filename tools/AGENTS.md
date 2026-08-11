# Holonomy CLI maintenance

`tools/` owns the developer-facing command line, Service client, launch compilation, bounded fixture descriptors, result rendering and documentation discovery. `tools/service/` is the only desktop owner for ADB/CDP, device/process/emulator leases and durable service state. The CLI must not fall back to direct ADB when the Service is unavailable, become a second JavaScript Runtime or duplicate Adapter semantics.

`tools/service/sandbox-policy.mjs` is the sole compiler for public SandboxPolicy input. The CLI may securely read and forward a policy file, but it must not derive capabilities or host authority. A fixture descriptor is separate from guest launch data: the Service acquires its bounded process lease, exposes the target URL, and atomically persists the effective policy and digest before any Adapter start. Terminal generations retain that lease; restart reuses or exactly rebinds its persisted loopback origin, while process removal, retention GC and Service drain release it. Adapters consume only that persisted policy and its generation-bound plan; plans never append authority. Public Process DTOs hide guest launch graphs, environment values, fixture URLs and compiled host details.

`tools/holonomy-launch-snapshot.mjs` owns the canonical module graph root carried with an immutable launch. `tools/service/launch-admission.mjs` and each target Adapter revalidate that the entry and supplied module URLs remain within it. Do not derive the root from a generated `.holonomy/` wrapper entry.

## Help and machine-documentation contract

- `holonomy --help` is the short discovery entry point. Keep it scannable and route readers to the `--readme` / `--llms` aliases; do not embed long protocol references in help output.
- `holonomy --readme` and `holonomy --llms` are exact aliases. With no path they print `tools/README.md`; with one explicit path they read the same bounded local Markdown input. Never let the aliases acquire different content, flags or security rules.
- Explicit Markdown discovery must not expand globs, enumerate directories, follow symbolic links or infer private documentation paths. It opens one regular file and enforces the byte bound on that same descriptor.

## OpenAPI scenario Skill publication

`.oo/skills/` is the scenario-publication surface of a specific OpenAPI service, not a generic project documentation folder and not a special-case rule for the CLI. A Skill may be published at `<openapi-base-url>/.oo/skills/<scenario>/SKILL.md` only when that service exposes every operation and lifecycle needed to complete the scenario. Name entries for complete user outcomes such as debugging one runtime process, mocking an HTTP exchange, running device conformance or collecting failure evidence. Do not organize them by implementation component such as CLI, ADB, CDP or Network Provider.

Each scenario Skill must:

- use the publishing service's public OpenAPI surface, with the Holonomy CLI allowed only as a documented prerequisite or launcher rather than the hidden implementation of the scenario;
- select an explicit device and runtime process before applying process-scoped state such as network rules;
- keep `SKILL.md` procedural and concise, with detailed schemas or examples in its own `references/` directory;
- link to canonical CLI/OpenAPI documentation instead of copying command and schema reference material;
- avoid claiming an unavailable capability and clean up only the processes or rules it created.

Do not create or publish an OpenAPI scenario Skill before the corresponding public operation and lifecycle owner exist. Component documentation, prerequisite tools and workflows that cannot be completed through that OpenAPI stay in their owning help/README surface instead of the service's `.oo/skills/` URL tree. The OpenAPI module must have its own nearest `AGENTS.md` for internal ownership and README files for external usage when it is introduced.

## Verification

- `pnpm test:cli`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
