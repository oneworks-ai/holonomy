# 整体架构

[English](../en/concepts/architecture.md)

Holonomy 把用户交互、长期资源管理、平台执行和公共 JavaScript 语义分成四层。Service 是唯一长期资源 owner，Node 与 Android Adapter 只实现各自平台的执行边界。

```mermaid
flowchart TB
  subgraph clients["调用方"]
    cli["Holonomy CLI"]
    api["OpenAPI Client / Agent Skill"]
  end

  service["机器级 Holonomy Service<br/>认证 · 状态 · 设备 · 进程 · 日志 · Lease"]
  policy["SandboxPolicy + Network Rules"]

  subgraph targets["平台执行层"]
    node["Node Adapter<br/>每个 Runtime 一个独立子进程"]
    android["Android Session Host<br/>Foreground Supervisor + 多逻辑 V8"]
  end

  subgraph runtime["共享 JavaScript Runtime 语义"]
    kernel["Event Loop · Module Loader · Native Bridge"]
    apis["Timers · Console · Fetch · Streams · Node Compatibility"]
  end

  guest["用户 JavaScript / node:test"]
  engine["Engine Host Ports<br/>Runtime thread · Clock · Wakeup · Microtask checkpoint"]
  native["Capability NativePort Providers<br/>Network 与显式授权的 Host 能力"]
  inspector["Generation-bound Inspector transport"]

  cli --> service
  api --> service
  policy -->|"Service 编译并冻结"| service
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
  native -. "输出与网络诊断" .-> service
  service <--> inspector
```

CLI 负责编译本地入口和呈现结果，不持有后台资源。Service 统一管理 Node、Android、ADB、AVD、Process、Network Rules 和 Inspector lease。共享 Runtime 拥有公开 JavaScript 行为；Engine Host Ports 提供 Runtime thread、时钟和唤醒等执行原语，Capability NativePort Providers 提供显式授权的 Host 能力，Inspector 则使用独立、generation-bound 的诊断传输。

## 控制面与数据面

```mermaid
flowchart LR
  control["控制面<br/>REST · SSE · Process lifecycle"]
  execution["执行面<br/>Runtime thread · V8/vm · NativePort"]
  diagnostics["诊断面<br/>Logs · Inspector · CDP Network"]

  control -->|"create / stop / restart / policy revision"| execution
  execution -->|"state / output / terminal"| control
  execution -->|"generation-bound diagnostics"| diagnostics
  diagnostics -->|"cursor / lease / bounded body"| control
```

三个平面共享 `processId + generation` 身份。旧 generation 的控制请求、输出或 Inspector 连接不能作用于新 Runtime。
