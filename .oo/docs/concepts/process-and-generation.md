# Process 与 Generation

[English](../en/concepts/process-and-generation.md)

`processId` 表示用户管理的稳定逻辑进程，`generation` 表示该进程当前的具体 Runtime 实例。

```mermaid
flowchart LR
  process["稳定 processId"]
  g1["Generation 1<br/>Runtime · NativeHost · Inspector"]
  fence["Restart<br/>停止并隔离旧事件"]
  g2["Generation 2<br/>全新 Runtime · NativeHost · Inspector"]

  process --> g1
  g1 --> fence
  fence --> g2
  process -. "身份保持不变" .-> g2
```

Restart 保留入口、模块快照、SandboxPolicy 和 `processId`，递增 generation，并重新创建目标 Adapter 的执行资源。旧 generation 的输出、完成事件、stop 请求和 Inspector lease 不能影响新 generation。

进程状态为：

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

`lost` 表示 Service 无法再证明目标资源仍可控制，例如 Android 设备离线。终态进程的 Restart 先以新 generation 回到 `queued`，再重新进入 staging。需要清理的 Android 资源会保留 `cleanupPending`，待设备恢复后继续核验和清理。
