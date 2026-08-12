# Known limitations

[简体中文](../../capabilities/known-limitations.md)

The following capabilities are explicitly outside the current production support boundary:

- Android `isolatedProcess`.
- A production sandbox filesystem provider for Node or Android.
- Arbitrary guest access to host paths.
- Android Crypto, Git, or Storage providers.
- An Android inbound HTTP/WebSocket server.
- Arbitrary guest `child_process`, shell, or ADB shell access.
- The complete Node.js API and every Node timing edge case.
- Web Streams BYOB, transferable streams, and complete Node objectMode streams.
- Production WebSocket client transport.
- Public unauthenticated CDP or OpenAPI.
- Network Mock rules that execute JavaScript, regular expressions, templates, files, or shell commands.
- Treating Android emulator results as physical-device acceptance.

The presence of a facade, type, capability matrix, or test provider in source does not mean that a platform adapter installs a corresponding production provider. A schema value that is admitted but returns a stable unsupported error remains unsupported.
