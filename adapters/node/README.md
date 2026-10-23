# Holonomy Node Adapter

[简体中文](./README.zh-Hans.md)

The Node adapter runs every Holonomy Runtime in a separate Node child process. The child starts with `--experimental-vm-modules`, creates a fresh `vm` Context, boots the platform-neutral Holonomy Runtime and then evaluates only the admitted session module graph.

It is intended as the Desktop/Node host behind the Holonomy CLI and control service. The adapter library provides:

- generation-bound start, status, rule update, stop and restart operations;
- bounded runtime log and network-diagnostic events;
- an optional Node Inspector endpoint for the exact child Runtime;
- the Node 22/V8 12.4 per-string/Wasm native Engine Gate, exact Loader/Inspector gates, a one-shot source reader, and bounded Host-only Runtime Observers;
- the shared Holonomy timers, console, Fetch, module loader and `node:*` compatibility modules;
- startup loading and last-known-good watch replacement for Cordis Runtime Plugins;
- the opt-in Stable macOS `native.darwin-seatbelt-v1` and Host-installable Experimental `experimental.v86-v1` Backends for the controlled `node:child_process` subset;
- an HTTP(S) host with authority checks, DNS resolution followed by exact-address pinning, original-host SNI/certificate verification, no connection pool and no automatic redirect.

The fresh guest Context has no ambient Node `process`, `require`, `Buffer` or host `fetch`. The shared Runtime installs its own bounded globals and its explicit frozen `node:*` registry inside that Context. Internal runtime modules use `holonomy:///runtime/*`; guest modules keep their caller-supplied absolute URL. The adapter rejects caller replacement of the internal Runtime graph.

Crypto is absent by default. A trusted Host can construct `new NodeRuntimeSupervisor({ crypto: { enabled: true } })` to install the existing shared `node:crypto` facade and `globalThis.crypto` after the complete shared provider self-test succeeds. The fixed synchronous subset is SHA-1/SHA-256, HMAC-SHA256, AES-256-GCM (32-byte key, 12-byte IV, 16-byte tag), OS-backed random bytes/UUID, and native constant-time byte comparison. WebCrypto provides `getRandomValues` and `randomUUID`; `subtle`, RSA/ECDSA, PBKDF2, other ciphers and asynchronous Node crypto are unsupported. Shared limits apply, including 64 active contexts, 1 MiB per update and 64 KiB per random call. Session data cannot enable or replace the provider. Each child generation has fresh native contexts; stop, failure and termination revoke them. Native Node objects never enter the Guest realm. This uses the adapter's existing child/VM boundary and makes no additional physical isolation claim. Root CLI/Service option plumbing is a separate integration step.

The Service is the only SandboxPolicy compiler. It sends the adapter an immutable policy plus its generation-bound compiled plan; direct callers cannot replace the authority. The default plan installs no Fetch capability. `mockOnly` installs the shared Fetch facade and mock router without constructing a Node HTTP provider, while `restricted` enables the HTTP(S) host only for the exact canonical origins, schemes, private-network decision and quotas in the policy. Rule revisions stay bound to the current process generation.

Filesystem watch delivery is best-effort. If the Host emits no native `fs.watch` callbacks, the adapter polls metadata of the watched file or directory itself without enumerating directory entries. Directory events may then have `filename: null`, and an in-place edit of an existing child file may produce no event. Consumers should rescan on a filename-free event rather than treating watch events as a complete change log.

This package remains the platform library seam. The root CLI and Service OpenAPI own user commands, Runtime Plugin bundles, process selection, and scenario publication. Process authority is never inferred from the operating system: the Service resolves a logical profile id through its private owner-only Host manifest before Runtime entry. If the profile is absent or denied, the controlled facade fails closed without falling back to ambient `child_process`.

See the public [controlled process guide](../../.oo/docs/en/capabilities/process.md) for the Host manifest, `--capability-runtime`, and `childProcessEnvironment` Symbol contract. `process-profile-v1` can reference installed Backends. The v86 implementation is an optional dependency but ships no Linux assets; agentOS and WASIX are not registered.

Controlled string/Wasm policy requires the narrow addon built for the exact Node/V8 ABI. A missing or unloadable addon rejects the whole generation before guest entry instead of silently enabling code generation. Run `pnpm run build:m4:node-hook` in a source checkout to build the current-platform addon. Package artifacts include its source, but do not claim install-ready cross-platform binaries until the prebuild ABI matrix is complete.

```js
import { NodeRuntimeSupervisor } from './adapters/node/src/index.mjs'

const runtime = new NodeRuntimeSupervisor()
await runtime.start(serviceCompiledSession)
await runtime.setRules({ mode: 'failClosed', rules })
await runtime.stop()
```

The Node FS Provider also uses a separate built-in N-API `openat` primitive on macOS/Linux to open files relative to pinned directory descriptors. Build it with `pnpm run build:node:filesystem-hook`; it is not a plugin or an Engine Gate extension. Missing binaries fail closed with no path-based fallback. The package includes its source, not install-ready prebuilds. This requirement belongs to the Node adapter; the standalone Rust `holo` binary uses its own OS adapter and does not require Node or this addon.

The same fixed filesystem addon supplies bounded FD-based time, access and directory primitives. Directory snapshots and sync retain the opened directory object through the shared resource lifecycle; they do not reopen a replaced pathname. These primitives remain Host-only and do not add native Runtime Plugins.

## Module-local verification

```sh
pnpm run test:adapter:node
```
