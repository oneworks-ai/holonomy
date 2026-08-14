# SandboxPolicy 参考

[English](../en/reference/sandbox-policy.md)

SandboxPolicy v1 是当前通用 CLI/Service 网络沙箱的不可变能力边界。Capability Runtime `kernel-slice` 另外接受 SandboxPolicy v2，并通过 `ProcessStartRequest.capabilityRuntime` 原子提交；精确请求 Schema 以 `/openapi.json` 为准。

## 最小策略

```json
{
  "schemaVersion": 1,
  "network": { "access": "none" },
  "filesystem": { "access": "none" }
}
```

## Restricted 网络

```json
{
  "schemaVersion": 1,
  "network": {
    "access": "restricted",
    "allowedOrigins": ["https://api.example.com"],
    "allowedSchemes": ["https"],
    "allowPrivateNetwork": false,
    "limits": {
      "maxChunkBytes": 65536,
      "maxConcurrentConnections": 8,
      "maxHeaderBytes": 65536,
      "maxHeaders": 128,
      "maxRequestBodyBytes": 1048576,
      "maxResponseBodyBytes": 8388608,
      "maxUrlBytes": 65536,
      "socketTimeoutMs": 30000
    }
  },
  "filesystem": { "access": "none" }
}
```

## 约束

- `allowedOrigins` 最多 64 个，必须是 canonical `http`/`https` origin，不能包含 path、query、fragment 或 credentials。
- `allowedSchemes` 只能是 `http`、`https`，并覆盖所有 origin。
- `allowPrivateNetwork=false` 会拒绝 loopback、link-local 与私网地址。
- 所有 limit 都有 Service hard cap；缩小限制可以，不能通过 guest 扩大。
- `mockOnly` 使用相同字段，但规则集必须 `failClosed` 且不能 passthrough。
- 普通 v1 启动路径的 `filesystem=sandboxed` 返回 `sandbox.capability_unsupported`。v2 Capability Runtime 只开放 `holo-fs://workspace/` 受控读写切片，不等同于完整生产文件系统 v1。

Service 会计算 canonical policy digest。初始 fixture 的精确 loopback origin 在 staging 中固化为 effective policy；对外 Process DTO 在完成前只显示 `pending`，完成后才显示 effective policy 与 digest。
