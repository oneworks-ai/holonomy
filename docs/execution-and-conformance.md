# Runtime execution and conformance

Case placement, ownership and anti-duplication rules are defined in the [testing strategy](./testing-strategy.md).

Holonomy uses one JavaScript execution model for applications, plugins, scripts and tests. A host receives an entry module and a module source provider; it does not receive an execution kind such as `test` or `application`.

## Layer ownership

```text
Holonomy CLI over ADB/CDP
  -> Android generic process/session host
     -> V8 lifecycle, runtime thread and native capability providers
        -> JavaScript Runtime Kernel and versioned primitive ports
           -> Node/Web APIs and node:test execution
              -> JavaScript program
```

The JavaScript layer owns standard-visible semantics. Native code owns operations whose correctness or performance depends on the operating system, runtime thread, monotonic time, blocking I/O, cryptography or large byte transfers.

| Capability | JavaScript ownership                                            | Native ownership                                                                     |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Timers     | public API, callback and argument records, exception semantics  | monotonic deadlines, timer queue, cancellation and runtime-thread wakeup             |
| Console    | formatting and Console API state                                | stdout/stderr process sink and Android Logcat mirror                                 |
| Fetch      | Request, Response, Headers, redirects and AbortSignal semantics | cancellable DNS, address-pinned HTTP/1.1 sockets, TLS, byte streams and cancellation |
| Streams    | state machines and backpressure semantics                       | platform byte sources and sinks only                                                 |
| Filesystem | Node overloads, virtual paths and stable errors                 | authorized filesystem operations                                                     |
| Crypto     | Node/Web facades and validation                                 | JCA or platform primitives                                                           |
| Tests      | registration, hooks, execution and structured summary           | no test semantics                                                                    |

Native callbacks never execute JavaScript from an arbitrary scheduler thread. Timer, I/O and Inspector completions are generation-bound and queued onto the runtime thread.

## Generic launch protocol

A launch request contains only generic process data:

```ts
interface RuntimeLaunchRequest {
  entryUrl: string
  modules: ReadonlyArray<{ url: string; source: string }>
  argv: readonly string[]
  env: Readonly<Record<string, string>>
  inspect?: { breakBeforeEntry: boolean; socketName: string }
}
```

The Android host creates V8, injects the reviewed primitive ports, evaluates `entryUrl`, forwards stdout/stderr and returns an exit code. It does not inspect filenames, import `node:test`, parse TAP or calculate coverage.

The desktop CLI owns device discovery, installation, session transfer, ADB process control, host fixtures, `adb reverse`, CDP forwarding, DevTools launch and report collection. `holonomy run` and `holonomy test` differ only in the JavaScript entry module assembled by the CLI. Android receives the same generic launch envelope in both cases.

When a selected conformance graph needs a desktop fixture, the CLI starts it on a random loopback port, reverses that exact port to the selected device, and injects only its public URL through the generic process environment. The Android runtime and HTTP provider do not inspect filenames or know that the module is a test. The CLI removes the reverse mapping and closes the fixture in the same `finally` scope as the runtime session.

The CLI and Android host enforce the same bounded session envelope: at most 512 modules, 8 MiB per module, 48 MiB for module sources, 64 MiB for the encoded request, bounded URLs/argv/env/Inspector metadata, 1 MiB per output event and 16 MiB of total process output. A CLI timeout sends a session-scoped cancel intent and waits for V8, native timers and Inspector disposal before removing the ADB forward and session files.

## Conformance source layout

Cross-platform tests live outside platform adapters:

```text
conformance/
  specs/
    console.test.mjs
    fetch.test.mjs
    node-modules.test.mjs
    timers.test.mjs
```

Tests use `node:test` and `node:assert/strict`. Holonomy extends the standard registration functions under a collision-resistant field:

```js
import { describe, it } from 'node:test'

describe('common timers', () => {
  it('runs everywhere', async () => {})
})

describe.holonomy.android('Android host details', () => {
  it.holonomy.android('uses the Android scheduler', async () => {})
})
```

Plain `describe` and `it` cases are always executed. Missing APIs are failures and therefore visible in capability coverage. Platform-specific cases are executed only on their matching platform, remain visible as skipped elsewhere, and are excluded from the cross-platform coverage numerator and denominator. A platform-specific failure still fails that platform's device gate.

The JavaScript `node:test` implementation returns a structured `TestRunSummary`. The CLI-generated test entry renders that summary as TAP or JSON through ordinary stdout. `console.*` output is diagnostic data, not the test-result protocol. Native adapters do not parse either format.

## Device workflow

```bash
holonomy run examples/basic.mjs --target android --device emulator-5554
holonomy run examples/debuggable.mjs --target android --device emulator-5554 --inspect=9229
holonomy test "conformance/specs/**/*.test.mjs" --target android --device emulator-5554
holonomy test conformance/specs/timers.test.mjs --target android --inspect-brk=9229
pnpm test:e2e:android
```

With Inspector enabled, the CLI forwards the device local-abstract socket to loopback, exposes one V8-only CDP target per runtime process and optionally opens the Electron DevTools shell. `--inspect-brk` pauses before the entry module, so breakpoints can be installed in external modules before tests begin. Inspector owns source/debugger protocol traffic; process stdout/stderr remains the portable result and diagnostic channel collected by the CLI.

The same CLI transport owns HTTP fixture reachability: the device connects to a loopback URL through `adb reverse`, while the Android `network-host` executes cancellable DNS, binds the socket to the admitted address, preserves the original host identity for HTTP and TLS, and performs credited response-body work over a bounded HTTP/1.1 exchange. Redirects are never followed by the transport; Fetch-visible request, response, redirect, abort and body semantics stay in JavaScript.

Android `androidTest` cases are a separate Adapter integration gate. They prove real Javet/V8, JSB/NativePort, provider and lifecycle behavior, but they are not developer CLI E2E and do not enter the common capability denominator. Only a command that starts from `holonomy run` or `holonomy test` and executes a `conformance/specs/` entry proves that complete developer path.

Reports separate common capability coverage from platform verification:

```text
Cross-platform capability coverage
Timers        4/4
Fetch         0/4
Node modules  3/3

Android implementation verification
V8 lifecycle  2/2
ADB/CDP       3/3
```

The strict command exits non-zero for any executed failure. Coverage exploration may explicitly request an allow-failures exit policy, but it never rewrites a failure as a skip or a pass.
