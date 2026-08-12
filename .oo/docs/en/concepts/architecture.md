# System architecture

[简体中文](../../concepts/architecture.md)

Holonomy separates user interaction, durable resource management, platform execution, and public JavaScript semantics into four layers. The Service is the single long-lived resource owner; Node and Android adapters implement only their platform execution boundary.

```mermaid
flowchart TB
  subgraph clients["Clients"]
    cli["Holonomy CLI"]
    api["OpenAPI Client / Agent Skill"]
  end

  service["Machine-level Holonomy Service<br/>Auth · State · Devices · Processes · Logs · Leases"]
  policy["SandboxPolicy + Network Rules"]

  subgraph targets["Platform execution"]
    node["Node Adapter<br/>One child process per Runtime"]
    android["Android Session Host<br/>Foreground Supervisor + logical V8 runtimes"]
  end

  subgraph runtime["Shared JavaScript Runtime semantics"]
    kernel["Event Loop · Module Loader · Native Bridge"]
    apis["Timers · Console · Fetch · Streams · Node Compatibility"]
  end

  guest["User JavaScript / node:test"]
  engine["Engine Host Ports<br/>Runtime thread · Clock · Wakeup · Microtask checkpoint"]
  native["Capability NativePort Providers<br/>Network and authorized host capabilities"]
  inspector["Generation-bound Inspector transport"]

  cli --> service
  api --> service
  policy -->|"Compiled and frozen by Service"| service
  service --> node
  service --> android
  node --> engine
  android --> engine
  engine --> kernel
  node --> native
  android --> native
  node --> inspector
  android --> inspector
  kernel --> apis
  apis --> guest
  kernel -->|"Capability-bound NativePort"| native
  native -. "Output and network diagnostics" .-> service
  service <--> inspector
```

The CLI compiles local entries and renders results without owning background resources. The Service owns Node, Android, ADB, AVD, Process, Network Rules, and Inspector leases. The shared Runtime owns public JavaScript behavior. Engine Host Ports provide execution primitives such as the runtime thread, clock, and wakeups; Capability NativePort Providers expose explicitly authorized host capabilities; Inspector uses a separate generation-bound diagnostics transport.

## Control, execution, and diagnostics

```mermaid
flowchart LR
  control["Control plane<br/>REST · SSE · Process lifecycle"]
  execution["Execution plane<br/>Runtime thread · V8/vm · NativePort"]
  diagnostics["Diagnostics plane<br/>Logs · Inspector · CDP Network"]

  control -->|"create / stop / restart / policy revision"| execution
  execution -->|"state / output / terminal"| control
  execution -->|"generation-bound diagnostics"| diagnostics
  diagnostics -->|"cursor / lease / bounded body"| control
```

All three planes share `processId + generation` identity. Commands, output, and Inspector connections from an old generation cannot affect a new Runtime.
