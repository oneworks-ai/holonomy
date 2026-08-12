# Node/Desktop platform

[简体中文](../../../platforms/node/index.md)

Each managed Runtime uses a separate Node child process, `--experimental-vm-modules`, and a fresh `vm` Context. The Context does not inherit the host `process`, `require`, `Buffer`, or `fetch`.

The shared Runtime installs audited globals, Node synthetic modules, Timers, Console, Fetch, and Network Mock. Only a `restricted` network policy creates a real Node HTTP(S) provider. After DNS authorization, the provider pins the exact address, preserves the original hostname for TLS/SNI/certificate validation, disables pooling, and does not follow redirects automatically.

Node Inspector belongs to the exact child Runtime. `--inspect-brk` publishes Inspector readiness before waiting for a generation-bound resume, so synchronous debugger waiting never blocks the Service start request.

The Node adapter is a platform integration layer; it does not grant host Node privileges to guest code. See the module [README](../../../../../adapters/node/README.md) for integration details.
