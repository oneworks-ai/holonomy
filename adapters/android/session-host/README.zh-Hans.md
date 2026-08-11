# Holonomy Android Session Host

[English](README.md)

`session-host` 是 Android 上无 UI 的长驻会话控制宿主。它负责 typed v2 命令、逻辑 runtime 监管、输出/结果快照、命令幂等、应用私有持久化、随机 local-abstract socket transport，以及 owner process 内的 concrete service。

它不负责 ADB 发现、设备选择、APK 安装，也不引入第二套 JavaScript 执行器。宿主应用通过 `SessionRuntimeFactory` 复用现有 Android runtime engine。

## 集成边界

library manifest 会合入 `exported=false` 的 `HolonomySessionSupervisorService`。宿主应用的 `Application` 必须实现 `HolonomySessionServiceProvider` 并返回：

- `SessionRuntimeFactory`：每个逻辑代际创建新的 `SessionRuntimeInstance`；
- `SessionNativeHostFactory`：每次 engine 请求都返回全新的 native-host 实例；
- 每个 instance 的 `SessionRuntimeControl`：把 opaque trusted control 串行转发到该 engine 的 runtime thread。

模块已提供 `JsonSessionControlCodec`、`AndroidLocalAbstractSessionControlTransport`，以及 `noBackupFilesDir/holonomy/session-v2` 下的应用私有 journal。service 只在 owner-private 的 `control/endpoint.v2` 中发布不可预测的 socket name；peer credential 仅允许 app UID、adb shell 或 adb root。

library manifest 已按 targetSdk 35 将 supervisor 声明为 `specialUse` foreground service。它会先启动一条常驻、低重要度通知，再构造 runtime dependencies；接入应用应保留合并后的 foreground-service permission/type/property，若要调整 channel 展示，只能在应用集成边界包装。

同应用 ingress 应先用 `SessionIngressCommandIds.random()` 生成随机 ID，再调用 `HolonomySessionCommandIngress.submit(command)`。它先写完整 command，然后只携带 `commandId` 启动 non-exported service。CLI 兼容入口继续复用已有 exported `HolonomyRuntimeActivity`：Activity 只能接收该随机 ID，再转发显式的 `HolonomySessionSupervisorService.commandIntent`，不能携带 command JSON。ADB 发现 `endpoint.v2` 必须走应用 owner/debug 授权路径，不能使用固定 socket name。

目前稳定支持的隔离 wire value 是 `runtime`。typed schema 接受 `isolatedProcess`，便于客户端协商能力；在真正的进程隔离实现落地前，supervisor 会用稳定错误码 `session.isolation_unsupported` 拒绝它。

每个 runtime spec 可携带严格的 `sandboxPolicy` v1。缺失时等价于：

```json
{
  "schemaVersion": 1,
  "network": { "access": "none" },
  "filesystem": { "access": "none" }
}
```

network access 可取 `none`、`mockOnly`、`restricted`。后两者必须显式给出不超过 64 个 canonical HTTP(S) origin、HTTP(S) scheme 子集、private-network 选择及有界 transport limits。`mockOnly` 只声明 mock capability，passthrough 始终 fail closed；只有 `restricted` 能创建真实 Android network provider。filesystem 的 `sandboxed` 可被 schema 识别，但会在 runtime 创建前以 `sandbox.capability_unsupported` 拒绝；v1 仅执行 `none`。

supervisor 会冻结 logical runtime 的 policy，restart 时复用同一策略，计算稳定 digest，并从 Android process 与 runtime generation 内部派生 native principal。command JSON 不能提供 principal。`SessionNativeHostFactory` 会收到完整 `SessionNativeHostContext`，接入方必须精确落实其 policy，不能扩大 authority。

## 控制语义

每条命令都携带 `runtimeId`、`commandId`，适用时还携带 `expectedGeneration`。重复提交完全相同的 `commandId` 会复用原始 reply/future；同一个 ID 对应不同命令会 fail closed。`restart` 会推进逻辑代际，创建新的 engine/native-host 链路，并丢弃旧代际的 output/exit 回调。
已完成 command/reply 只保留有界的近期 replay window；in-flight command 不会被逐出，最旧的 completed entry 会为后续 lifecycle command 让出容量。

`control` 只携带 operation 名和有界 JSON value。Android 不解释 network matcher 规则。initial controls 在 engine start 之后、用户 entry module 之前经可信 runtime-thread seam 下发；后续 control 必须绑定当前 expected generation。

输出事件使用 runtime 内单调递增的 sequence。status reply 会返回当前保留窗口，controller 因而可以识别游标过期，并从 `firstAvailableSequence` 继续消费。
