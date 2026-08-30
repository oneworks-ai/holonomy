# Known limitations

[简体中文](../../capabilities/known-limitations.md)

The following capabilities are explicitly outside the current production support boundary:

- Android `isolatedProcess`.
- Other `node:fs` APIs not declared by Appendix H, and Host paths outside configured `holo-fs://` virtual roots.
- Arbitrary guest access to host paths.
- Android Crypto, Git, or Storage providers.
- An Android inbound HTTP/WebSocket server.
- `child_process`, PATH lookup, arbitrary shell, or ADB shell access that was not admitted by a Host manifest and Process Policy. An admitted v86 profile permits PATH lookup only when it resolves to an absolute target in the executable allowlist. The macOS `process-profile-v1` + `native.darwin-seatbelt-v1` combination is always non-default and opt-in.
- The default Host Registry enables no Experimental Process Backend. Node/Desktop v86 requires an owner-private installation manifest; Android v86 requires the optional production AAR, a Host profile, and an explicit asset switch. Neither core package ships Linux assets by default, and agentOS/WASIX are not registered.
- Native Darwin currently enters Cordis before the root `child_process` call and applies static Seatbelt constraints to descendants; it cannot ask the Host before each descendant `exec`. Node/Desktop and Android-emulator v86 now experimentally cover kernel-level `execve`, restricted `execveat`, and PATH-resolved admission. Relative dirfd, `AT_EMPTY_PATH`, relative executables, and unknown targets are always denied.
- The v86 filesystem bridge supports one Host-authorized root mapped to `/workspace`, not arbitrary mounts or a complete POSIX filesystem. The current profile remains x86-32, single-core, and Experimental; initial-state boot support is not a claim of true VM snapshot/restore.
- Dynamic Runtime Plugin replacement / `--watch` on Android; Android currently supports static startup Bundles only.
- The complete Node.js API and every Node timing edge case; `provider-v1` claims only the capabilities listed in the support matrix.
- Web Streams BYOB, transferable streams, and complete Node objectMode streams.
- Production WebSocket client transport.
- Public unauthenticated CDP or OpenAPI.
- Network Mock rules that execute JavaScript, regular expressions, templates, files, or shell commands.
- Treating Android emulator results as physical-device acceptance.

The presence of a facade, type, capability matrix, or test provider in source does not mean that a platform adapter installs a corresponding production provider. A schema value that is admitted but returns a stable unsupported error remains unsupported.
