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
| `node:process`         | 🟡     | argv/env/cwd/platform/stdio, nextTick; no arbitrary process control   |
| `node:stream`          | 🟡     | In-memory Readable/Writable/Duplex/Transform/Pipeline                 |
| `node:stream/promises` | 🟡     | `pipeline` and `finished` subset                                      |
| `node:stream/web`      | 🟡     | Default WHATWG stream constructors                                    |
| `node:console`         | 🟡     | Bounded Console API                                                   |
| `node:timers`          | 🟡     | timeout/interval and Immediate; not complete libuv phase semantics    |
| `node:test`            | 🟡     | Sequential runner and before/after/beforeEach/afterEach               |
| `node:assert/strict`   | 🟡     | Strict assertion subset used by conformance                           |

Guest code does not receive the host `require`, the real host `process`, the real host `Buffer`, or the system `fetch`. Every module comes from the Runtime synthetic registry.

`Buffer.alloc(size, fill?, encoding?)` supports numeric, string and `Uint8Array` fills with UTF-8/hex/base64/base64url encoding. Plain objects, other TypedArrays and unknown encodings are not silently treated as zero fill. `allocUnsafe` remains safely zero-initialized; full Node implicit coercion is not claimed.

With an explicit FS Policy and Provider, macOS Native/Node also expose controlled sync/callback/Promise or FileHandle forms of `utimes/futimes`, `truncate/ftruncate`, `fsync/fdatasync`, and `access`. Time inputs are nonnegative finite seconds or decimal strings; Date and `bigint:true` remain unsupported, and ordinary Stats do not expose Host nanosecond strings. Read-only handles may sync; mutation retains separate authority and byte ceilings. This increment has no Android-device acceptance and is not complete POSIX/Node FS.

Composed `process.nextTick` shares the existing Event Loop queue; callbacks and arguments are never serialized to Host. CJS/ESM entry priorities relative to Promises are separately verified, and recursion remains budgeted. A raw Node Core factory without an injected local scheduler stays explicitly unsupported. Composed globals and `node:timers` also provide `setImmediate`/`clearImmediate`, handle reference controls and bounded batches; the raw timer factory still owns only timeout/interval. New evidence is macOS Native and Node, not Android-device acceptance or complete Node/libuv I/O-phase compatibility.

`node:assert/strict` `throws/rejects` supports error-object fields, regular expressions, constructors and validators that must return literal `true`; it never ignores an expected error code. Success returns `undefined` or a Promise fulfilled with `undefined`. `rejects` does not accept plain thenables. Native/Node use engine-internal Promise brands without invoking a Guest `then` getter. Common Date, RegExp, Map, Set and binary built-ins are compared by contents, not considered equal merely because they lack own keys. This remains a partial Node deep-comparison surface.

macOS Native/Node `chmod/fchmod` requires a separate `chmod` right on the virtual root; write or possession of an FD does not imply it. Sync/callback/Promise/FileHandle forms accept 0..0777 or digit-only octal strings, not special/type bits or a string such as `0o644`. Stats.mode reports actual type/permission bits. A readonly data FD may change metadata after independent authorization but still cannot write data. A mode-000 path that cannot be safely opened may be conservatively refused; its retained FD can restore permissions.

The shared Loader supports package `imports` aliases, patterns and conditions using exact targets. Bare built-in names only alias Host-declared `node:*` bindings. See the [Native platform](../platforms/native/index.md) for physical-dependency-tree and directory-diagnostic limits.

An FS-enabled Native Runtime delivers error-first callbacks as local Event Loop tasks: `process.nextTick` scheduled inside a callback precedes Promise jobs. Success, failure and void callbacks retain their respective argument counts; a thrown callback enters the Runtime's uncaught-error boundary. Promise API ordering is unchanged. This is scoped callback evidence, not complete Node/libuv phase compatibility or Android-device acceptance.

The authoritative fine-grained matrices live in `packages/runtime/src/node-compat/capabilities.ts` and `packages/runtime/src/streams/capabilities.ts`. This page keeps only the stable user-facing summary.
