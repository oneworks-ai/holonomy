# Holonomy Node Adapter

[简体中文](./README.zh-Hans.md)

The Node adapter runs every Holonomy Runtime in a separate Node child process. The child starts with `--experimental-vm-modules`, creates a fresh `vm` Context, boots the platform-neutral Holonomy Runtime and then evaluates only the admitted session module graph.

It is intended as the Desktop/Node host behind the Holonomy CLI and control service. The adapter library provides:

- generation-bound start, status, rule update, stop and restart operations;
- bounded runtime log and network-diagnostic events;
- an optional Node Inspector endpoint for the exact child Runtime;
- the shared Holonomy timers, console, Fetch, module loader and `node:*` compatibility modules;
- an HTTP(S) host with authority checks, DNS resolution followed by exact-address pinning, original-host SNI/certificate verification, no connection pool and no automatic redirect.

The fresh guest Context has no ambient Node `process`, `require`, `Buffer` or host `fetch`. The shared Runtime installs its own bounded globals and its explicit frozen `node:*` registry inside that Context. Internal runtime modules use `holonomy:///runtime/*`; guest modules keep their caller-supplied absolute URL. The adapter rejects caller replacement of the internal Runtime graph.

The Service is the only SandboxPolicy compiler. It sends the adapter an immutable policy plus its generation-bound compiled plan; direct callers cannot replace the authority. The default plan installs no Fetch capability. `mockOnly` installs the shared Fetch facade and mock router without constructing a Node HTTP provider, while `restricted` enables the HTTP(S) host only for the exact canonical origins, schemes, private-network decision and quotas in the policy. Rule revisions stay bound to the current process generation.

This package is currently a library seam. The root CLI and future OpenAPI service own user commands, process selection and scenario publication.

```js
import { NodeRuntimeSupervisor } from './adapters/node/src/index.mjs'

const runtime = new NodeRuntimeSupervisor()
await runtime.start(serviceCompiledSession)
await runtime.setRules({ mode: 'failClosed', rules })
await runtime.stop()
```

## Module-local verification

```sh
node --experimental-vm-modules --test adapters/node/test/*.test.mjs
```
