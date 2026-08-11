# Holonomy CLI

[简体中文](./README.zh-Hans.md)

The `holonomy` command runs JavaScript and `node:test` files on Android or the isolated local Node host. A machine-level Holonomy Service owns devices, managed Runtime processes, logs, network rules and Inspector leases, so callers do not assemble ADB or CDP commands.

## Discover the CLI

```sh
holonomy --help
holonomy --readme [MARKDOWN]
holonomy --llms [MARKDOWN]
```

- `--help` prints the compact command and option map.
- `--readme` and `--llms` are aliases. With no path, both print this external guide.
- With one `<markdown>` path, either alias prints that explicitly selected local reference. The input must be a regular UTF-8 `.md` file no larger than 256 KiB.

For example, a tool can progressively load one project-owned scenario document without loading every reference:

```sh
holonomy --llms ./.oo/skills/debug-runtime-process/references/cdp-api.md
```

## Run and test

```sh
holonomy run examples/basic.mjs --target node
holonomy run examples/debuggable.mjs --target android --device emulator-5554 --sandbox conformance/sandbox/restricted.json
holonomy test "conformance/specs/**/*.test.mjs" --target android --device emulator-5554 --sandbox conformance/sandbox/restricted.json
holonomy test conformance/specs/fetch.test.mjs --target android --sandbox conformance/sandbox/restricted.json --inspect-brk --devtools
```

`--target` is required. Commands use `--openapi auto` by default, which starts or reuses the owner-only loopback Service. Use `--detach` to return a stable process id; use `--env KEY=VALUE` and `--arg VALUE` for bounded guest process input. `--inspect` and `--inspect-brk` enable a process-scoped CDP lease, and `--devtools` opens Holonomy DevTools.

Every process defaults to a deny-all SandboxPolicy. Pass a bounded regular JSON file with `--sandbox FILE` when the process needs capabilities. Network access is `none`, `mockOnly`, or `restricted`; the Service validates and freezes the policy for the process generation. A service-owned conformance fixture is staged before the Adapter starts, and its exact runtime origin is atomically included in the effective policy. Its bounded process lease survives terminal generations so restart keeps the same origin; explicit process removal, retention expiry, or Service drain releases it. Process responses report `sandboxPolicyState: pending` without a policy until that staging completes, then expose only the effective policy and digest. `mockOnly` can use fail-closed declarative mocks but never reaches a native HTTP provider. `restricted` admits only its canonical schemes, origins, private-network choice, and byte/concurrency limits. Filesystem access defaults to `none`; `sandboxed` is currently rejected as unsupported. Guest launch input cannot provide compiled authorities, Provider tokens, Runtime modules, or capabilities.

The CLI freezes `--root-url` as the module graph root. The Service and target Adapter revalidate that the entry and every supplied module remain under that canonical root; generated `.holonomy/` entries therefore cannot accidentally narrow the developer's graph.

An explicit remote Service must use HTTPS outside loopback. Pass its Token with `--openapi-token-file` or `HOLONOMY_OPENAPI_TOKEN_FILE`, never as a command-line value.

## Manage the Service and Runtime processes

```sh
holonomy service start
holonomy service status
holonomy device list
holonomy emulator list
holonomy process list
holonomy process logs <process-id> --follow
holonomy process inspect <process-id> --devtools
holonomy process stop <process-id>
holonomy service stop --drain
```

The Service is a machine-level singleton and remains active until it is explicitly stopped. A normal stop refuses while owned Runtime or emulator resources remain; `--drain` stops only resources owned by that Service instance. Final process state and bounded logs are retained for 24 hours unless explicitly removed.

Use `--network-rules rules.json` to install one process-scoped rule set before the entry module executes. Rules must stay within the immutable SandboxPolicy: mock-only rules are fail closed and cannot passthrough. Runtime updates go through the OpenAPI rule resource and an `If-Match` revision; guest JavaScript cannot replace its Provider, policy or rule set.

## Scenario Skills

`.oo/skills/` is not a general project documentation directory. A Holonomy OpenAPI service may publish a Skill at `<openapi-base-url>/.oo/skills/<scenario>/SKILL.md` only when its OpenAPI exposes the complete scenario. Suitable scenarios include debugging one runtime process, installing process-scoped network mock rules, running conformance on a selected device and collecting failure evidence.

This rule is based on OpenAPI ownership, not on whether something is a CLI or a component: prerequisites and workflows that the service cannot execute remain in their owning help/README documentation. Published scenario Skills use the service's public operations and must not construct private ADB, CDP or session protocols themselves.

The Service publishes its OpenAPI document at `/openapi.json` and complete scenario Skills under `/.oo/skills/`. Component-only references remain in their owning README and are not published as Skills.
