# Testing strategy and ownership

This is an internal maintenance rule. Public instructions and evidence categories live under [`.oo/docs/testing/`](../docs/testing/index.md).

Holonomy tests follow the product architecture. Each layer verifies only the contract it owns; the top layer verifies a complete developer journey, while lower layers exhaustively verify their own state machines and boundaries.

```text
Developer CLI end-to-end
  -> CLI and Service orchestration
     -> Platform Adapter
        -> JavaScript API
           -> JavaScript Runtime Kernel
```

This is an ownership model, not a strict call sequence. Adapters host the Runtime, the Runtime installs JavaScript APIs, and the resulting graph executes developer code.

## Layer owners

| Layer            | Owns                                                                                                                             | Does not own                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Developer E2E    | Real `holonomy run`/`test` journey, public output, exit status, reports, and external fixture effects                            | Exhaustive semantic or internal race matrices                         |
| CLI/Service      | Parsing, graph packaging, target selection, resource lifecycle, ADB/CDP orchestration, logs, and report rendering                | Fetch, timer, Node module, or Runtime scheduling semantics            |
| Platform Adapter | Engine/thread constraints, NativePort transport, generation identity, native authorization/I/O, Inspector transport, and cleanup | Public JavaScript API semantics                                       |
| JavaScript API   | Node/Web overloads, validation, public state machines, streams, encoding, and stable public errors                               | Android, Javet, JNI, socket, or filesystem implementation details     |
| Runtime Kernel   | Event Loop, Module Loader, Native Bridge, resource identity, quotas, disposal, and composition                                   | CLI processes, Android behavior, or public API compatibility matrices |

## Directory topology

```text
__tests__/
  js-runtime-kernel/<component>/
  js-api/<component>/
  cli/
  support/                    # only genuinely shared JavaScript fixtures

adapters/<platform>/<module>/
  src/test/                   # native unit, contract, lifecycle, security
  src/androidTest/            # real Android engine/OS integration

conformance/
  specs/                      # real developer CLI end-to-end cases
```

Tests follow the implementation owner. Do not create a centralized native test package that duplicates adapter contracts. Android instrumentation is Adapter integration evidence; only the real CLI path through `conformance/specs/` is developer E2E evidence.

## Boundary contracts

Every boundary has one contract owner:

- CLI ↔ host process: CLI/session protocol.
- Adapter ↔ Runtime: Runtime host and NativePort contracts.
- JavaScript API ↔ host capability: the JavaScript capability port.
- Runtime Kernel ↔ JavaScript API: Runtime composition and module registry.

When several adapters implement one contract, keep one reusable contract suite with the boundary owner and run every implementation against it.

## Duplication rule

The same capability may appear at several layers only when each assertion answers a different layer question. For a regression:

1. Put the exhaustive case in the lowest owning layer that contains the defect.
2. Add one upper-layer regression only when that boundary or developer journey was also unprotected.
3. Never leave an E2E as the only protection for a lower-layer state-machine defect.
4. Never copy a complete public semantic matrix into native, CLI, and E2E suites.

## Determinism and evidence

- Common conformance uses standard `node:test`/`node:assert/strict`, deterministic local fixtures, and no public internet dependency.
- Missing common capabilities fail; they do not auto-skip. Explicit `*.holonomy.<platform>` cases are separate platform evidence.
- Timing and race tests use controlled clocks, transports, or latches instead of arbitrary sleeps.
- Every admitted resource completes or is disposed in `finally`.
- Report Runtime, JavaScript API, CLI/Service, Adapter, and E2E evidence separately.
- Label Android emulator and physical-device evidence separately. Emulator success never implies physical-device acceptance.

Before adding a case, identify its owning layer, public contract, existing equivalent coverage, deterministic fixture owner, and cleanup boundary.
