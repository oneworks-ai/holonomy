# Support matrix

[简体中文](../../capabilities/support-matrix.md)

Status: ✅ supported; 🟡 supported subset; ⛔ unsupported; 🧪 implemented, but evidence is insufficient for a complete platform claim.

## Platforms and lifecycle

| Capability                             | Node/Desktop                                     | Android emulator                           | Physical Android device                                                                     |
| -------------------------------------- | ------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `holonomy run` / `test`                | ✅                                               | ✅                                         | 🧪 Same implementation path; emulator evidence is not treated as physical-device acceptance |
| Foreground wait and `--detach`         | ✅                                               | ✅                                         | 🧪                                                                                          |
| list/show/logs/stop/restart/remove     | ✅                                               | ✅                                         | 🧪                                                                                          |
| Inspector and DevTools                 | ✅                                               | ✅                                         | 🧪                                                                                          |
| Network Mock                           | ✅                                               | ✅                                         | 🧪                                                                                          |
| Runtime Plugin startup loading         | ✅ Full Cordis App                               | 🟡 Static synchronous Host realm           | 🧪 Same implementation path; emulator evidence is not physical-device acceptance            |
| Runtime Plugin capability interception | ✅ Graph/drain                                   | 🟡 Static synchronous graph                | 🧪 Same implementation path; emulator evidence is not physical-device acceptance            |
| Runtime Plugin `--watch`               | ✅ Last-known-good                               | ⛔                                         | ⛔                                                                                          |
| Multiple runtimes                      | ✅ Separate OS child processes                   | ✅ Multiple logical V8 runtimes in one app | 🧪                                                                                          |
| `isolatedProcess`                      | Not applicable: already a separate child process | ⛔                                         | ⛔                                                                                          |

The standalone Rust/V8 `holo` is a separate Native target, not the Node Adapter in the table. Its controlled macOS arm64 Process subset has real JS/Service/watch and termination-cleanup evidence, but remains default-denied: only Host-private selected programs, `processTree`, no network/mounts and no descendant fork/re-exec. See [Native Process configuration](../../../../adapters/desktop/process-native-darwin.md). This does not expand Android or Windows support claims.

The optional Native v86 [bounded network bridge](../../../../adapters/desktop/process-v86-network.md) remains Experimental: twelve Guest JS cases cover actual Linux TCP/UDP, Host DNS, curl HTTP, denial/redirect, strict AbortError, socket quotas and fresh-Runtime isolation. [One-shot Device/System reads](../../../../adapters/desktop/process-v86-capabilities.md) have eight separate cases covering field authority, privacy clipping, per-process source and closed domains. Networking uses Process Policy rather than JS Fetch grants. Default-binary, Darwin-profile and fork/shared-VM restrictions remain unchanged; this does not claim Linux Device events, complete TLS, address-family or tool compatibility.

Standalone Native macOS arm64 can also explicitly [install Desktop Device](../../../../adapters/desktop/device.md). Its six required APIs and display/lifecycle subscriptions have real read, initial snapshot, overflow/getter-resync, permission and generation tests. Physical display/lifecycle changes were not independently observed; sampled change delivery has controlled-source tests only. This does not establish complete Native M3 acceptance or expand Node/Android support.

Native Service can also admit five optional [Host-plugin Observer](../../../../adapters/desktop/observer.md) events from its actual platform descriptor; Node callback IDs do not become Native registrations. Real CJS/ESM, fixed failure diagnostics, plugin replacement and generation cases are verified. This remains inline partial support: no configurable external event sink, possible indefinite synchronous callback blocking, and no enforced separation of shared closure state from plugin authorization logic. It is not complete M4 acceptance.

Standalone Native can separately select experimental [diagnostic profiles](../../../../adapters/desktop/observer-profiles.md): dedicated processes/isolates, effective deadlines and bounded owner-private JSONL, without moving old inline closures. Real Guest JS, another profile/Gate/FS progress and fault/permission paths have focused evidence. [Service owners can install](../../../../adapters/desktop/managed-observer-profiles.md) separate resources selected by logical ID with private per-generation output. Complete Native/M4 acceptance remains separate.

## JavaScript runtime

| Capability                         | Status | Notes                                                                   |
| ---------------------------------- | ------ | ----------------------------------------------------------------------- |
| ESM module graph                   | ✅     | Absolute hierarchical URLs, relative imports, bounded module graph root |
| Timers                             | ✅     | timeout, interval, cancellation, generation fencing                     |
| Console                            | 🟡     | debug/log/info/warn/error with bounded, redacted formatting             |
| Fetch                              | ✅     | Installed only when SandboxPolicy allows it                             |
| Request/Response/Headers           | ✅     | Public semantics are owned by the JavaScript layer                      |
| AbortController/AbortSignal        | ✅     | Fetch cancellation and stable terminal states                           |
| Web Streams                        | 🟡     | Default readers/writers; no BYOB or transferable streams                |
| Node Streams                       | 🟡     | In-memory streams; no objectMode or encoding transforms                 |
| `node:test` / `node:assert/strict` | 🟡     | Sequential runner, common hooks, TAP/JSON                               |

## Security

| Capability                              | Node/Desktop             | Android emulator | Notes                                                                                                                                                               |
| --------------------------------------- | ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network denied by default               | ✅                       | ✅               | No Fetch provider is installed for `network=none`                                                                                                                   |
| Mock-only network                       | ✅                       | ✅               | Unmatched requests fail closed and make zero native transport calls                                                                                                 |
| Restricted network                      | ✅                       | ✅               | Canonical origins/schemes, private-network policy, and resource limits                                                                                              |
| Live rule revisions                     | ✅                       | ✅               | Protected by generation and `If-Match`                                                                                                                              |
| Capability Runtime `provider-v1`        | ✅                       | ✅               | The Appendix H, D.3, System, and Network v1 surfaces plus the secure plugin graph have completed M3 platform acceptance                                             |
| Sandbox filesystem v1                   | ✅                       | ✅               | Shared Guest conformance covers Appendix H, watch overflow, quotas, Abort, and atomic behavior; platform restart E2E covers old-generation resources and TOCTOU     |
| Host System Projection v1               | ✅                       | ✅               | Host-selected real/synthetic/redacted/unavailable fields with no ambient host disclosure by default                                                                 |
| Target-required Device Provider         | ✅ Headless              | ✅               | Node/Desktop currently publishes the Headless Node descriptor; Android-required reads, real change, revision/resync, and fencing are closed                         |
| Network Broker continuation v1          | ✅                       | ✅               | Real/mock, every redirect hop, DNS/private-IP, Response body/clone, cancellation, diagnostics, and Rules revisions                                                  |
| Android source Runtime SDK              | N/A                      | 🟡               | Production bootstrap/AAR; API 29+, device evidence on API 35 arm64; not Maven publication or a single-file SDK                                                      |
| Crypto primitive Provider               | 🟡 Explicit              | 🟡 Explicit      | Native, Android JCA and trusted Node constructor reuse the shared SHA/HMAC/AES-GCM subset; Node CLI/Service does not auto-install it and sessions cannot enable it  |
| Persistent Storage Provider             | 🟡 Native KV/SQLite only | 🟡 Explicit KV   | Android default binary namespace only; no built-in Node Adapter Provider, Android SQLite, credentials or physical-device acceptance                                 |
| Controlled `node:child_process` profile | 🟡                       | 🧪               | The macOS Native profile is opt-in Stable; Android's optional v86 AAR is Experimental                                                                               |
| Experimental v86 Linux Backend          | 🧪                       | 🧪               | The upgraded image passed 6/6 Node production cases and 13/13 shared JS cases on an Android API 35 arm64 emulator; Native evidence remains scoped                   |
| v86 shared `runtime` VM                 | ❌                       | ❌               | Current v86 supports one VM per root in `processTree` only; network packets lack nontransferable PID binding, so Host profiles cannot enable shared scope           |
| v86 descendant pre-execution admission  | ❌                       | ❌               | The upgraded image denies every Guest fork/clone and exec after the trusted root's initial call; old Host allow/deny evidence does not cover this security boundary |

`provider-v1` claims only the surfaces listed by Appendix H, D.3, System Projection, and Network v1. It is not a claim of complete Node.js or physical-Android support. See the [secure capability kernel](../concepts/capability-runtime.md) for the invocation order and exact boundary.

## Control plane

| Capability                                | Status |
| ----------------------------------------- | ------ |
| Loopback Service + Token                  | ✅     |
| Remote Service over TLS                   | ✅     |
| OpenAPI 3.1                               | ✅     |
| SSE and log cursors                       | ✅     |
| Device inventory and managed AVDs         | ✅     |
| Daemon restart recovery and lease cleanup | ✅     |
| Four OpenAPI scenario Skills              | ✅     |

The physical-device column expresses the evidence boundary, not a known incompatibility. See [Conformance](../testing/conformance.md) for evidence categories.
