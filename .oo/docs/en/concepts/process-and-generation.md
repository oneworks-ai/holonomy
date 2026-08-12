# Process and Generation

[简体中文](../../concepts/process-and-generation.md)

`processId` is the stable user-managed logical process. `generation` identifies its current concrete Runtime instance.

```mermaid
flowchart LR
  process["Stable processId"]
  g1["Generation 1<br/>Runtime · NativeHost · Inspector"]
  fence["Restart<br/>stop and fence old events"]
  g2["Generation 2<br/>fresh Runtime · NativeHost · Inspector"]

  process --> g1
  g1 --> fence
  fence --> g2
  process -. "identity remains stable" .-> g2
```

Restart preserves the entry, module snapshot, SandboxPolicy, and process id, increments generation, and recreates target resources. Old output, completions, stop requests, and Inspector leases cannot affect the new generation.

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> staging
  staging --> starting
  starting --> waiting_for_debugger
  starting --> running
  waiting_for_debugger --> running: resume
  waiting_for_debugger --> stopping: stop
  running --> stopping: stop
  staging --> failed
  starting --> failed
  running --> failed
  stopping --> exited
  stopping --> cancelled
  stopping --> failed
  running --> exited
  running --> lost
  exited --> queued: restart / generation + 1
  failed --> queued: restart / generation + 1
  cancelled --> queued: restart / generation + 1
  lost --> queued: restart / generation + 1
```

`lost` means the Service can no longer prove control, for example while an Android device is offline. Restart moves a terminal process back to `queued` with a new generation before staging begins. Android cleanup remains pending and resumes after the device returns.
