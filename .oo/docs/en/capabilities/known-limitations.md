# Known limitations

[简体中文](../../capabilities/known-limitations.md)

The following capabilities are explicitly outside the current production support boundary:

- Android `isolatedProcess`.
- A complete production sandbox filesystem provider for Node or Android; only the controlled workspace `kernel-slice` is exposed.
- Arbitrary guest access to host paths.
- Android Crypto, Git, or Storage providers.
- An Android inbound HTTP/WebSocket server.
- `child_process`, PATH lookup, arbitrary shell, or ADB shell access that was not admitted by a Host manifest and Process Policy. The macOS `process-profile-v1` + `native.darwin-seatbelt-v1` combination is always non-default and opt-in.
- The default Host Registry enables no Experimental Process Backend. v86 requires an owner-private installation manifest and ships no Linux assets; agentOS/WASIX are not registered, and Android has no production Backend.
- Dynamic Runtime Plugin replacement / `--watch` on Android; Android currently supports static startup Bundles only.
- The complete Node.js API and every Node timing edge case.
- Web Streams BYOB, transferable streams, and complete Node objectMode streams.
- Production WebSocket client transport.
- Public unauthenticated CDP or OpenAPI.
- Network Mock rules that execute JavaScript, regular expressions, templates, files, or shell commands.
- Treating Android emulator results as physical-device acceptance.

The presence of a facade, type, capability matrix, or test provider in source does not mean that a platform adapter installs a corresponding production provider. A schema value that is admitted but returns a stable unsupported error remains unsupported.
