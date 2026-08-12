# Node compatibility modules

[简体中文](../../capabilities/node-compatibility.md)

Holonomy provides a restricted, frozen compatibility surface that does not depend on ambient Node globals. It is not a complete Node.js implementation.

| Module                 | Status | Main scope                                                            |
| ---------------------- | ------ | --------------------------------------------------------------------- |
| `node:buffer`          | 🟡     | Creation, UTF-8/base64/base64url/hex, slicing, comparison             |
| `node:events`          | 🟡     | Common EventEmitter registration, removal, emission, and error events |
| `node:path`            | 🟡     | POSIX paths; no `path.win32`                                          |
| `node:url`             | 🟡     | `URL`, `URLSearchParams`; limited file URL conversion                 |
| `node:os`              | 🟡     | Restricted platform snapshot frozen at startup                        |
| `node:process`         | 🟡     | argv/env/cwd/platform/stdio; no arbitrary process control             |
| `node:stream`          | 🟡     | In-memory Readable/Writable/Duplex/Transform/Pipeline                 |
| `node:stream/promises` | 🟡     | `pipeline` and `finished` subset                                      |
| `node:stream/web`      | 🟡     | Default WHATWG stream constructors                                    |
| `node:console`         | 🟡     | Bounded Console API                                                   |
| `node:timers`          | ✅     | timeout/interval                                                      |
| `node:test`            | 🟡     | Sequential runner and before/after/beforeEach/afterEach               |
| `node:assert/strict`   | 🟡     | Strict assertion subset used by conformance                           |

Guest code does not receive the host `require`, the real host `process`, the real host `Buffer`, or the system `fetch`. Every module comes from the Runtime synthetic registry.

The authoritative fine-grained matrices live in `src/node-compat/capabilities.ts` and `src/streams/capabilities.ts`. This page keeps only the stable user-facing summary.
