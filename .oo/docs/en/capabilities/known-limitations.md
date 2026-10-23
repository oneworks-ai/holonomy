# Known limitations

[简体中文](../../capabilities/known-limitations.md)

The following capabilities are explicitly outside the current production support boundary:

- Android `isolatedProcess`.
- Other `node:fs` APIs not declared by Appendix H, and Host paths outside configured `holo-fs://` virtual roots.
- Arbitrary guest access to host paths.
- Android Git, SQLite Storage and credential providers. Optional Crypto and persistent KV have production modules and shared-JS emulator evidence, but are not installed by default and have no physical-device acceptance.
- Built-in Node Adapter Storage Providers. Crypto requires the trusted `NodeRuntimeSupervisor({ crypto: { enabled: true } })` constructor; ordinary CLI/Service startup does not install it and a session cannot upgrade that choice. Standalone Rust/V8 and Android implementations do not automatically enable Node Adapter Providers.
- An Android inbound HTTP/WebSocket server.
- `child_process`, PATH lookup, arbitrary shell, or ADB shell access that was not admitted by a Host manifest and Process Policy. The upgraded v86 image permits only the initial root executable from the Host manifest; later Guest PATH lookup or exec is denied. The macOS `process-profile-v1` + `native.darwin-seatbelt-v1` combination is always non-default and opt-in.
- The default Host Registry enables no Experimental Process Backend. Node/Desktop v86 requires an owner-private installation manifest; Android v86 requires the optional production AAR, a Host profile, and an explicit asset switch. Neither core package ships Linux assets by default, and agentOS/WASIX are not registered.
- Native Darwin currently enters Cordis before the root `child_process` call and applies static Seatbelt constraints to descendants; it cannot ask the Host before each descendant `exec`. The previous v86 image experimentally tested Host admission before descendant execution, but seccomp `CONTINUE` cannot atomically bind Guest pointer arguments. The upgraded image denies later Guest `execve`/`execveat` and fork/clone, and exposes only one-root-per-VM `processTree` scope.
- Experimental Native v86 networking claims only verified bounded TCP/UDP, Host DNS and HTTP proxying. HTTP CONNECT, custom TLS roots, Guest AF_INET6, UDP fragmentation and broader TLS acceptance remain outside this support slice; see [Native v86 networking](../../../../adapters/desktop/process-v86-network.md).
- The v86 filesystem bridge supports one Host-authorized root mapped to `/workspace`, not arbitrary mounts or a complete POSIX filesystem. The current profile remains x86-32, single-core, and Experimental; initial-state boot support is not a claim of true VM snapshot/restore.
- Native v86 has verified touch, ls, file/directory sync and Host refusal; an explicitly chmod-authorized profile also verifies Git init and empty-repository status. This slice is not clone/push, hooks, all checkout behavior or full Git/POSIX compatibility. Native access and path chmod conservatively refuse mode-000 objects that cannot be safely descriptor-pinned, with no raw-path fallback.
- Dynamic Runtime Plugin replacement / `--watch` on Android; Android currently supports static startup Bundles only.
- The complete Node.js API and every Node timing edge case; `provider-v1` claims only the capabilities listed in the support matrix.
- Controlled ChildProcess/pipe support string-event `on`/`addListener`, `once`, `off`/`removeListener`, `removeAllListeners`, `listenerCount`, `listeners` and `eventNames`, not complete Node EventEmitter behavior. Symbols, public emit, prepend, rawListeners and max-listener configuration remain unsupported. Local removal does not physically cancel Host subscriptions; resource close still owns their reclamation.
- The default Runtime `AbortSignal.timeout()` accepts integer milliseconds from 0 through 4294967295. Zero still fires in a later Event Loop task, and a timeout alone does not keep the Runtime alive. Its reason is an `Error` named `TimeoutError`, not a full DOM `DOMException`. Delays beyond one Event Loop timer interval are waited in segments rather than taking Node's timer-overflow shortcut.
- The default Runtime `AbortSignal.any()` accepts genuine signals created by the same Runtime constructor, chooses an already aborted reason in input order, and removes the other upstream listeners after the first abort. Mixing signals from different Runtimes or realms is outside this implementation's compatibility range; explicitly injected native Abort constructors retain their host semantics.
- An active Native `fetch()` response body aborted by an AbortSignal after headers rejects reads with the original `signal.reason`; its default is an `Error` named `AbortError`, not a complete DOM `DOMException`. Before-header and pre-aborted requests still use `network.cancelled`; buffered clones after native transport EOS do not follow a later signal. Explicit reader cancellation, Runtime disposal and Provider errors are not converted into user abort reasons. Complete Fetch compatibility is not claimed.
- Web Streams BYOB, transferable streams, and complete Node objectMode streams.
- Production WebSocket client transport.
- Public unauthenticated CDP or OpenAPI.
- Enforced isolation of old Native inline Observer closures; they still share Host-plugin state and may block indefinitely. Explicit isolated diagnostic profiles and bounded private output are experimental standalone/owner-private Service capabilities, not a public remote event-export API, complete audit history, or an instantaneous RSS hard guarantee.
- Network Mock rules that execute JavaScript, regular expressions, templates, files, or shell commands.
- Treating Android emulator results as physical-device acceptance.

The presence of a facade, type, capability matrix, or test provider in source does not mean that a platform adapter installs a corresponding production provider. A schema value that is admitted but returns a stable unsupported error remains unsupported.
