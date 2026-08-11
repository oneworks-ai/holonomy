# Testing strategy

[简体中文](./testing-strategy.zh-Hans.md)

Holonomy tests follow the product architecture. Each layer verifies only the contract it owns. The top layer verifies the complete developer journey; lower layers verify their own behavior exhaustively.

```text
Developer CLI end-to-end scenario
  -> CLI orchestration
     -> platform adapter
        -> native engine host or native capability provider
        -> JavaScript APIs
           -> JavaScript Runtime Kernel
```

This is a test-ownership model, not a literal call stack. At execution time an adapter hosts the JavaScript Runtime Kernel, which installs the JavaScript APIs and runs developer code.

## 1. Developer CLI end-to-end

**Question:** Can a developer give the Holonomy CLI a JavaScript entry and observe it working on the selected runtime target?

- Entry: `holonomy run` and `holonomy test`.
- Cases: `conformance/specs/` and a small number of multi-capability scenarios.
- Uses the real CLI, session packaging, selected adapter, JavaScript Runtime Kernel and public JavaScript APIs.
- Asserts only developer-visible results: stdout/stderr, exit status, test report, returned values and externally visible fixture effects.
- Uses controlled local fixtures, but does not replace a product layer with a mock.
- Keeps one representative happy path and a small number of critical failure paths per capability. It does not repeat lower-layer edge-case matrices.

A common case is written once and executed unchanged on Desktop, Android and future hosts. `.holonomy.<platform>` is reserved for an intentional platform-specific promise and is reported outside the common denominator.

## 2. CLI

**Question:** Does the CLI correctly turn a developer command into a bounded runtime session and collect its result?

- Owns argument parsing, file discovery, module-graph packaging, target/device selection, ADB transfer and reverse, CDP forwarding, process lifecycle, stdout/stderr collection and report rendering.
- Uses fake or recorded device/process/session endpoints where practical.
- Does not retest `fetch`, timers, Node modules or Runtime scheduling semantics.
- Does not inspect Adapter private state. It asserts only the documented CLI-to-host protocol and command result.

## 3. Platform adapter

**Question:** Does a native host faithfully implement the runtime/host contract on its platform?

- Location: the owning module under `adapters/<platform>/`; tests stay beside that module rather than moving into one coarse adapter test package.
- Owns engine creation, runtime-thread confinement, JSB/NativePort serialization, generation identity, provider authorization, native I/O, cancellation, byte transfer, Inspector transport and teardown.
- Uses minimal protocol calls or tiny JavaScript probes to exercise the native boundary.
- Does not reproduce public JavaScript API semantics such as the complete Fetch redirect matrix or timer-handle behavior.
- Platform instrumentation proves the real engine and OS path; native unit tests exhaust native state, races and cleanup.
- Native engine-host tests group engine, transport/JSB, lifecycle and Inspector responsibilities. Each native capability provider groups contract, transport, lifecycle and security responsibilities.
- Android instrumentation is Adapter integration evidence. It is not developer CLI E2E because it does not start from `holonomy run` or `holonomy test`.

## 4. JavaScript API

**Question:** Do Holonomy's Node/Web APIs behave correctly when their declared host ports behave according to contract?

- Location: `__tests__/js-api/<component>/`, grouped by the corresponding `src/` module.
- Owns overloads, validation, public state machines, stable errors, streams, redirects, encoding and Node/Web compatibility.
- Uses deterministic fake ports, clocks and reference providers through public contracts.
- Does not inspect Android/Javet/JNI/JSB internals or assert how a native adapter implements a port.
- A native implementation bug belongs to Adapter tests; a public semantic bug belongs here.

## 5. JavaScript Runtime Kernel

**Question:** Are the platform-neutral execution primitives correct independently of any public API or native host?

- Location: `__tests__/js-runtime-kernel/<component>/` for the event loop, module loader, Native Bridge, resources, composer and lifecycle.
- Owns scheduling, module identity and planning, request generations, resource ownership, quota accounting, disposal and runtime composition.
- Uses the smallest deterministic ports needed by the core contract.
- Does not launch CLI processes, assert Android behavior or repeat public API behavior owned by the JavaScript layer.
- This layer is implemented in TypeScript/JavaScript. V8/Javet, the runtime thread, JSB transport and Inspector belong to the native engine host in the Adapter layer.

## Concrete test topology

```text
__tests__/
  js-runtime-kernel/
    event-loop/
    module-loader/
    native-port/
    runtime-composer/
  js-api/
    fetch and network facades/
    node-fs/
    crypto/
    streams/
    timers/
    runtime-console/
    node-test/
    other public capability modules/
  cli/
  support/                    # only cross-component JS test fixtures

adapters/<platform>/<module>/
  src/test/                   # native unit/contract/lifecycle/security tests
  src/androidTest/            # real Android engine/OS integration where needed

conformance/
  specs/                      # real developer CLI end-to-end cases
```

### Android adapter topology

Android tests continue to follow their real owner; there is no centralized tests module:

```text
adapters/android/
  host-core/src/test/.../
    contract/                 # engine-host contract and stable errors
    engine/                   # runtime thread and native scheduling primitives
    lifecycle/                # generation, termination, wakeup and disposal
    support/                  # the module's single shared seam
  v8-host/src/test/.../
    engine/                   # V8/Javet architecture and construction
      inspector/              # Inspector configuration and transport
    lifecycle/                # native-host generation and restart/close
  network-host/src/test/.../
    contract/                 # NativePort schema, authority and resource binding
    transport/                # DNS snapshot, socket/TLS, HTTP framing and bytes
    lifecycle/                # cancellation, deadline, watchdog and close/dispose
    security/                 # private-network policy, managed input and quotas
    support/                  # the provider's single shared seam
  e2e/src/androidTest/.../
    engine/                   # real Android engine composition
      transport/              # real NativePort transport
      inspector/              # real Inspector socket
    session/lifecycle/        # Android session cancellation and cleanup
    session/security/         # Android session input/output limits
```

`pnpm test:adapter:android:unit` aggregates the three native JVM modules. `pnpm test:adapter:android:device` explicitly reuses device instrumentation and is not part of `pnpm test`. Instrumentation starts the Android Adapter directly rather than entering through the CLI, so it is Adapter integration evidence only.

`pnpm test:e2e:android` is the separate developer E2E gate. It invokes the real `holonomy test "conformance/specs/**/*.test.mjs" --target android` path and is intentionally excluded from the default `pnpm test` unit aggregate.

`RuntimeCompositionInstrumentationTest` currently retains one broad Composer/module-planning/Event-Loop/NativePort/disposal smoke. It remains the only combined regression evidence under a real V8 assembly. Narrow it only after equivalent lower-layer tests and smaller instrumentation probes exist; physical reclassification alone is not grounds for deleting its assertions.

The three Vitest sets are path-owned, disjoint and exhaustive. `pnpm test:topology` rejects a `*.spec.ts` outside them. Use `pnpm test:runtime`, `pnpm test:js` and `pnpm test:cli` for the individual layers; `pnpm test` remains the aggregate gate.

Fetch and filesystem illustrate the native/public split:

| Capability | JavaScript API owns                                                                               | Native provider owns                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Fetch      | `Request`, `Response`, `Headers`, redirect, abort and body-stream semantics                       | DNS, address authorization, sockets/TLS, transport bytes, native cancellation and cleanup                                      |
| Filesystem | Node overloads, virtual paths, flags/encoding, callback/Promise behavior and stable public errors | root authorization, real file operations, handle identity, atomic replacement, quotas, cancellation and path-escape protection |

Neither side tests the other's private implementation.

## Boundary contracts

Every boundary has one contract owner:

| Boundary                                   | Contract owner                          | Implementations prove                                                    |
| ------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------ |
| CLI ↔ host process                         | CLI/session protocol                    | They accept and complete the bounded generic session                     |
| Adapter ↔ runtime                          | Runtime host/NativePort contract        | Threading, transport, identity, cancellation and cleanup                 |
| JavaScript API ↔ host capability           | JavaScript capability port              | The adapter satisfies the port; JS tests own public semantics            |
| JavaScript Runtime Kernel ↔ JavaScript API | Runtime composition and module registry | The API is installed and reachable under the declared module/global name |

When several adapters implement the same contract, keep one reusable contract suite with the boundary owner and run each implementation against it. Do not copy the assertions into every adapter.

## Duplication rule

The same capability may appear in more than one layer only when each assertion answers a different layer question. For example:

- JavaScript Runtime Kernel: a credited native completion is delivered once.
- JavaScript API: `fetch()` exposes the correct streamed `Response` behavior.
- Android Adapter: the native HTTP provider obeys credit, cancellation and socket cleanup.
- Developer E2E: `holonomy run fetch.mjs --target android` returns the expected body and exit status.

This is not duplicate coverage. Copying the complete Fetch header, redirect or cancellation matrix into all four layers would be duplicate coverage.

For every regression:

1. Put the exhaustive case in the lowest owning layer that contains the defect.
2. Add one upper-layer regression only if that boundary or developer-visible path was also unprotected.
3. Never use an E2E failure as the only protection for a lower-layer state-machine bug.
4. Never add a lower-layer test merely to reproduce an already-owned public semantic assertion.

## Case and reporting rules

- Developer conformance files use standard `node:test` and `node:assert/strict`. The JavaScript `node:test` implementation owns registration, hooks, execution and a structured `TestRunSummary`; only the CLI renders TAP or JSON.
- Common E2E cases are deterministic, bounded and independent of public internet services.
- Missing common capabilities fail; capability-based auto-skip is not allowed.
- Fixtures have one owner. The CLI owns ADB, CDP, device selection, local fixture lifecycle and injected environment values.
- Timing and race cases use controlled clocks, transports or latches instead of arbitrary sleeps.
- Every admitted resource is completed or disposed in `finally`.
- Report each layer separately. Only plain common E2E cases contribute to the cross-platform capability numerator and denominator; platform-specific cases, CLI tests, Adapter tests, JS tests and Runtime tests are separate evidence.

## Review checklist

Before accepting a case, ask:

1. Which of the five layers owns the behavior?
2. Is the assertion limited to that layer's public contract?
3. Does another case already prove the same thing at the same layer?
4. If this is E2E, does it prove a complete developer journey rather than an internal branch?
5. If this is not E2E, can it run without starting layers above it?
6. Are fixtures, resources, deadlines and diagnostics deterministic and cleaned up?
