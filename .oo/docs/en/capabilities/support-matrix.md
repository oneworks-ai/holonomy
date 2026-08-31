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

| Capability                              | Node/Desktop | Android emulator | Notes                                                                                                                                                           |
| --------------------------------------- | ------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network denied by default               | ✅           | ✅               | No Fetch provider is installed for `network=none`                                                                                                               |
| Mock-only network                       | ✅           | ✅               | Unmatched requests fail closed and make zero native transport calls                                                                                             |
| Restricted network                      | ✅           | ✅               | Canonical origins/schemes, private-network policy, and resource limits                                                                                          |
| Live rule revisions                     | ✅           | ✅               | Protected by generation and `If-Match`                                                                                                                          |
| Capability Runtime `provider-v1`        | ✅           | ✅               | The Appendix H, D.3, System, and Network v1 surfaces plus the secure plugin graph have completed M3 platform acceptance                                         |
| Sandbox filesystem v1                   | ✅           | ✅               | Shared Guest conformance covers Appendix H, watch overflow, quotas, Abort, and atomic behavior; platform restart E2E covers old-generation resources and TOCTOU |
| Host System Projection v1               | ✅           | ✅               | Host-selected real/synthetic/redacted/unavailable fields with no ambient host disclosure by default                                                             |
| Target-required Device Provider         | ✅ Headless  | ✅               | Node/Desktop currently publishes the Headless Node descriptor; Android-required reads, real change, revision/resync, and fencing are closed                     |
| Network Broker continuation v1          | ✅           | ✅               | Real/mock, every redirect hop, DNS/private-IP, Response body/clone, cancellation, diagnostics, and Rules revisions                                              |
| Controlled `node:child_process` profile | 🟡           | 🧪               | The macOS Native profile is opt-in Stable; Android's optional v86 AAR is Experimental                                                                           |
| Experimental v86 Linux Backend          | 🧪           | 🧪               | Both production modules have Runtime E2E for `/workspace` FUSE, TCP/UDP/DNS, Device/System, stdio, and restart; Android evidence is emulator-only               |
| v86 descendant pre-execution admission  | 🧪           | 🧪               | Both prove kernel pause, Host allow/deny, PATH-resolved targets, and unknown/relative denial; restricted `execveat` also enters the gate                        |

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
