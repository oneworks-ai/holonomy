# Experimental Native v86 networking

[简体中文](process-v86-network.zh-Hans.md)

A Rust `holo` built with `v86-backend` routes bounded Linux TCP, UDP and HTTP proxy traffic through the existing Process authority chain. The default binary neither includes nor activates v86. The native macOS Darwin Process profile still denies networking; this option does not grant ambient Host-process networking.

## Host selection

Follow [Host configuration](host-configuration.md) to install digest-verified agent assets and private Backend/profile manifests, then explicitly select `--experimental-v86-process`. Set the Process Policy's `network` to `restricted`, for example:

```json
{
  "access": "restricted",
  "endpoints": [
    { "hostname": "localhost", "ports": [8080], "transport": "tcp" }
  ],
  "maxSockets": 1,
  "privateNetwork": "allow"
}
```

This is `sandboxPolicy.process.network`, not ordinary JS Fetch's `sandboxPolicy.network`; the latter may remain `none`. The explicit private-network permission is for the local fixture and is not the default.

The image must actually report `seccompUserNotification`, or networking fails before the workload starts. The Host fixes the image, endpoints, quotas and activation. Guest cannot select another Backend or bypass Policy. The current image still rejects fork/clone and execution after the root's initial exec; networking does not enable descendants.

## Linux tools and middleware

Guest uses the existing Node child-process API and installed logical executable IDs. HTTP uses the pinned v86 proxy, not a Host shell or Node fetch fallback:

```js
import { execFile } from 'node:child_process'

execFile(
  'curl',
  [
    '--noproxy',
    '',
    '--proxy',
    'http://192.168.86.1:80',
    'http://8080.external/'
  ],
  { encoding: 'utf8' },
  (error, stdout, stderr) => {
    if (error) throw error
    console.log(stdout)
  }
)
```

The example requires a Host-owned fixed-text server on local port 8080 and an installed `curl` ID. The pinned proxy maps `PORT.external` to Host `localhost:PORT`; real Host DNS evidence, private-network permission and endpoint admission still apply. This is not a claim of arbitrary Guest DNS or AF_INET6 support.

Each new TCP/UDP flow or initial HTTP request consumes an authentic HoloUV process-source ticket before `process.network.connect` enters Kernel/Broker. Host plugins can inspect the executable, Linux PID/parent PID, start ticks and process resource in `request.source`. The Host checks all resolved addresses and pins the actual connection; Guest DNS replies are not authoritative evidence. Redirects retain the original authentic source but require fresh admission and address pinning per hop. A denied endpoint receives no connection.

Proxy hop headers are removed; target Host and length are rebuilt from the admitted URL and actual body. Cross-endpoint redirects strip Authorization/Cookie. Responses are pulled on demand; bodies and native tokens are not automatically exported to logs or Observer.

## Direct curl HTTPS

Linux curl can perform TLS itself over an explicitly allowed Process `tcp` endpoint. A Host may expose a **public CA certificate only** through the normal read-only `/workspace` FUSE mount, then use `curl --noproxy '*' --cacert /workspace/ca.pem https://<allowed-address>:<port>/`. Both Process mount and ordinary FS read authority remain required; keys must stay outside the mount. This path does not use the HTTP proxy or grant ordinary JS Fetch.

Here `tcp` is an opaque connection grant: Host middleware sees the admitted endpoint and process source, not encrypted HTTP methods/headers or a Host-verified HTTPS origin/SNI. Curl owns its CA/hostname checks. This does **not** allow a `tls` authority receipt to be consumed by the raw-TCP transport; Host-managed HTTPS and its trust-root configuration remain separate.

`HOLO_V86_PRODUCTION_ASSET_ROOT=/absolute/verified-agent pnpm test:native:v86-https` runs six actual Guest JS cases: trusted CA success, wrong CA, wrong hostname, Policy and middleware denial, and a redirect to a denied new endpoint. The two certificate failures reach the allowed TCP/TLS server but send no HTTP request; only the authority-denied targets have zero TCP connections. Certificates and servers are task-owned, and no public internet service is required.

## Current limits

| Item           | Limit                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform/grade | macOS arm64, explicitly installed, Experimental                                                                                                |
| Connections    | Intersection of Process `maxSockets` and the Host ceiling of 32                                                                                |
| DNS            | All-address checks, at most 64 addresses, monotonic evidence valid for at most 30 seconds                                                      |
| UDP            | 1472-byte payload; no fragment reassembly                                                                                                      |
| HTTP           | 32 KiB request body, 8 MiB response body, 16 KiB pulls                                                                                         |
| Headers / URL  | 64 pairs / 16 KiB; 2048-byte URL                                                                                                               |
| Memory/waits   | Bounded VM, Host and Native queues; 4 MiB Host write queue; operations at most 30 seconds and subject to earlier execution/cancellation limits |
| Not claimed    | HTTP CONNECT, general HTTPS proxying, custom roots for the Host Process HTTPS client, Guest AF_INET6, listeners/PTY, deep process trees        |

Direct Guest curl TLS has the bounded verification above, not full address-family or HTTPS-proxy acceptance. [One-shot Device/System reads](process-v86-capabilities.md) have their own selected domains and authority; broader FS and VM snapshot/restore are separate work. This increment does not promote v86 beyond Experimental.

## Repeatable verification

```sh
node tools/build-native-runtime.mjs
cargo build --locked -p holonomy-cli --features holonomy-desktop-v8/v86-backend
HOLO_V86_PRODUCTION_ASSET_ROOT=/absolute/verified-agent pnpm test:native:v86-network
```

This explicit gate fails rather than skipping when assets, the feature or the Host IPv4 fixture are unavailable. It starts task-owned servers and executes real `holo test` with an empty PATH: six basic network cases, five cancellation/close/quota cases including pre-aborted nextTick delivery, and one new-Runtime isolation case. Abort asserts exactly one `ABORT_ERR`/`AbortError` before close, not just a killed process. It also checks external effects, zero connections to denied/quota-probe/pre-aborted endpoints, and a real pending old Runtime's exit. Node is only the fixture driver; the Runtime, VM, authority and I/O use Rust/embedded V8. Production delivery retains its separate release and platform gates.
