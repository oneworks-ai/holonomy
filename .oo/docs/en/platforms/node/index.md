# Node/Desktop platform

[简体中文](../../../platforms/node/index.md)

Each managed Runtime uses a separate Node child process, `--experimental-vm-modules`, and a fresh `vm` Context. The Context does not inherit the host `process`, `require`, `Buffer`, or `fetch`.

The shared Runtime installs audited globals, Node synthetic modules, Timers, Console, Fetch, and Network Mock. Only a `restricted` network policy creates a real Node HTTP(S) provider. After DNS authorization, the provider pins the exact address, preserves the original hostname for TLS/SNI/certificate validation, disables pooling, and does not follow redirects automatically.

Node Inspector belongs to the exact child Runtime. `--inspect-brk` publishes Inspector readiness before waiting for a generation-bound resume, so synchronous debugger waiting never blocks the Service start request.

Node/Desktop can load Cordis Runtime Plugins before Guest entry with `--config holo.config.json`; `--watch` applies last-known-good revision replacement over the configuration array. Both the Stable macOS `native.darwin-seatbelt-v1` and Experimental `experimental.v86-v1` are enabled explicitly through private Host manifests plus `--capability-runtime`, and expose the same controlled `node:child_process` facade without becoming default CLI authority. v86 additionally requires `process-backends.json` and Host-supplied digest-bound Linux assets. See the [controlled process capability](../../capabilities/process.md).

The Node adapter is a platform integration layer; it does not grant host Node privileges to guest code. See the module [README](../../../../../adapters/node/README.md) for integration details.
