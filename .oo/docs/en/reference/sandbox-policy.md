# SandboxPolicy reference

[简体中文](../../reference/sandbox-policy.md)

SandboxPolicy v1 is the immutable boundary for the general CLI/Service network sandbox. The Capability Runtime `kernel-slice` additionally accepts SandboxPolicy v2, submitted atomically through `ProcessStartRequest.capabilityRuntime`; `/openapi.json` remains authoritative for the exact request schema.

## Minimum policy

```json
{
  "schemaVersion": 1,
  "network": { "access": "none" },
  "filesystem": { "access": "none" }
}
```

## Restricted network

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

## Constraints

- `allowedOrigins` accepts at most 64 canonical `http`/`https` origins without paths, queries, fragments, or credentials.
- `allowedSchemes` can contain only `http` and `https` and must cover every origin.
- `allowPrivateNetwork=false` rejects loopback, link-local, and private addresses.
- Every limit has a Service hard cap. Guest code can reduce a limit but cannot enlarge it.
- `mockOnly` uses the same authority fields, but requires a `failClosed` rule set and forbids passthrough.
- The ordinary v1 launch path returns `sandbox.capability_unsupported` for `filesystem=sandboxed`. The v2 Capability Runtime exposes only a controlled `holo-fs://workspace/` read/write slice, not the complete production filesystem v1.

The Service computes a canonical policy digest. During staging, a fixture's exact loopback origin is frozen into the effective policy. The public Process DTO shows only `pending` before completion and exposes the effective policy and digest only after finalization.
