# Support matrix

[简体中文](../../capabilities/support-matrix.md)

Status: ✅ supported; 🟡 supported subset; ⛔ unsupported; 🧪 implemented, but evidence is insufficient for a complete platform claim.

## Platforms and lifecycle

| Capability                         | Node/Desktop                                     | Android emulator                           | Physical Android device                                                                     |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `holonomy run` / `test`            | ✅                                               | ✅                                         | 🧪 Same implementation path; emulator evidence is not treated as physical-device acceptance |
| Foreground wait and `--detach`     | ✅                                               | ✅                                         | 🧪                                                                                          |
| list/show/logs/stop/restart/remove | ✅                                               | ✅                                         | 🧪                                                                                          |
| Inspector and DevTools             | ✅                                               | ✅                                         | 🧪                                                                                          |
| Network Mock                       | ✅                                               | ✅                                         | 🧪                                                                                          |
| Multiple runtimes                  | ✅ Separate OS child processes                   | ✅ Multiple logical V8 runtimes in one app | 🧪                                                                                          |
| `isolatedProcess`                  | Not applicable: already a separate child process | ⛔                                         | ⛔                                                                                          |

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

| Capability                    | Status | Notes                                                                  |
| ----------------------------- | ------ | ---------------------------------------------------------------------- |
| Network denied by default     | ✅     | No Fetch provider is installed for `network=none`                      |
| Mock-only network             | ✅     | Unmatched requests fail closed and make zero native transport calls    |
| Restricted network            | ✅     | Canonical origins/schemes, private-network policy, and resource limits |
| Live rule revisions           | ✅     | Protected by generation and `If-Match`                                 |
| Filesystem denied by default  | ✅     | Host paths are not exposed                                             |
| Production sandbox filesystem | ⛔     | `filesystem=sandboxed` returns stable 501                              |

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
