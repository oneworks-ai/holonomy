# RFC-0001 附录 A：SandboxPolicy 与组合 Capability

[返回 RFC 总览](../0001-holo-capability-runtime.md)

本附录是规范性合同。未知字段、未知版本和缺失能力一律拒绝；宿主 Middleware 不能扩大这里定义的上限。

```ts
type NetworkLimitNameV2 =
  | 'maxChunkBytes'
  | 'maxConcurrentConnections'
  | 'maxHeaderBytes'
  | 'maxHeaders'
  | 'maxRequestBodyBytes'
  | 'maxResponseBodyBytes'
  | 'maxUrlBytes'
  | 'maxRedirects'
  | 'socketTimeoutMs'
```

## A.1 SandboxPolicy v2

```ts
interface SandboxPolicyV2 {
  readonly schemaVersion: 2
  readonly network: NetworkSandboxV2
  readonly filesystem: FilesystemSandboxV2
  readonly systemInformation: SystemInformationSandboxV2
  readonly device: DeviceSandboxV2
  readonly codeGeneration: CodeGenerationSandboxV2
  readonly inspector: InspectorSandboxV2
  readonly diagnostics: DiagnosticsSandboxV2
  readonly process: ProcessSandboxV2
}

type NetworkSandboxV2 =
  | { readonly access: 'none' }
  | {
    readonly access: 'mockOnly' | 'restricted'
    readonly allowedOrigins: readonly string[]
    readonly allowedSchemes: readonly ('http' | 'https')[]
    readonly allowPrivateNetwork: boolean
    readonly requestBodyInspection:
      | { readonly access: 'none' }
      | {
        readonly access: 'bounded'
        readonly maxBytes: number
        readonly maxReadsPerRuntime: number
      }
    readonly limits: Readonly<Record<NetworkLimitNameV2, number>>
  }

type FilesystemSandboxV2 =
  | { readonly access: 'none' }
  | {
    readonly access: 'sandboxed'
    readonly roots: readonly FilesystemRootV2[]
    readonly limits: FilesystemLimitsV2
  }

interface FilesystemRootV2 {
  readonly rootId: string
  readonly virtualUrl: `holo-fs://${string}/`
  readonly rights: readonly FilesystemRightV2[]
  readonly symlinks: 'deny' | 'withinRoot'
}

type FilesystemRightV2 =
  | 'read'
  | 'write'
  | 'list'
  | 'create'
  | 'delete'
  | 'move'
  | 'watch'

interface FilesystemLimitsV2 {
  readonly maxOpenHandles: number
  readonly maxReadBytes: number
  readonly maxWriteBytes: number
  readonly maxDirectoryEntries: number
  readonly maxWatchers: number
}

interface SystemInformationSandboxV2 {
  readonly defaultMode: 'unavailable'
  readonly fields: Readonly<
    Partial<Record<SystemInformationFieldV1, SystemFieldCeilingV1>>
  >
}

interface SystemFieldCeilingV1 {
  readonly allowedModes: readonly SystemExposedProjectionModeV1[]
  readonly maxPrecision?: 'exact' | 'coarse' | 'redacted'
}

interface DeviceSandboxV2 {
  readonly defaultAccess: 'deny'
  readonly operations: Readonly<
    Partial<Record<DeviceOperationV1, DeviceGrantCeilingV1>>
  >
  readonly maxSubscriptions: number
  readonly maxEventsPerSecond: number
}

interface DeviceGrantCeilingV1 {
  readonly access: 'allow'
  readonly maxPrivacyTier: 0 | 1 | 2 | 3
  readonly maxPrecision: 'coarse' | 'standard' | 'exact'
}

interface CodeGenerationSandboxV2 {
  readonly strings: CodeKindPolicyV2
  readonly wasm: CodeKindPolicyV2
  readonly dynamicImport: CodeKindPolicyV2
}

type CodeKindPolicyV2 =
  | { readonly access: 'none' }
  | {
    readonly access: 'controlled'
    readonly maxSourceBytes: number
    readonly maxOperations: number
    readonly decisionTimeoutMs: number
  }

interface InspectorSandboxV2 {
  readonly evaluate: boolean
  readonly compileScript: boolean
  readonly runScript: boolean
  readonly callFunctionOn: boolean
  readonly setScriptSource: boolean
}

interface DiagnosticsSandboxV2 {
  readonly sourceReader: 'none' | 'metadataOnly' | 'boundedSource'
  readonly observerEvents: readonly RuntimeObserverSelectableEventNameV1[]
  readonly maxSourceReadBytes: number
  readonly maxQueuedEvents: number
  readonly maxObserverCallbackMs: number
  readonly retentionMs: number
}
```

所有object使用`additionalProperties:false`；精确数组、字符串、数字、跨字段hard cap由[附录 A.2](policy-limits-v2.md)冻结。缺失顶层字段按最小拒绝值补齐后再计算canonical form，不能解释为allow。Policy使用RFC8785风格canonical JSON和小写SHA-256生成`policyDigest`，generation内不可变。

## A.2 旧版本与 restart

- v1 只映射已存在的 Network 字段；FS、Process、system information、device、code generation、Inspector 和 diagnostics 全部映射为 deny。
- 不支持的 schemaVersion 在 Guest 创建前返回 Host/Service admission code `runtime.policy_version_unsupported`，不做猜测迁移；它不属于 Guest facade error。
- restart 可以提交新 Policy，但必须创建新 generation、principal 和 digest；运行中不能原地替换。
- Host 可以进一步收紧 hard cap，不能接受超过平台上限的 Policy。

## A.3 组合 Capability

Operation Registry 只保存 `OperationCapabilityRequirementTemplateV1`（name/version DNF）。Broker 必须在同一次调用的 argument snapshot 与 CanonicalResource 都冻结后，用 operation-owned、machine-registered materializer 生成下列具体 requirement；不得把空 constraints 解释为 wildcard，也不得让 Guest 提供 materialized requirement。

```ts
interface CapabilityRefV1 {
  readonly name: string
  readonly version: 1
  readonly constraints: Readonly<Record<string, JsonValueV1>>
}

interface CapabilityBranchV1 {
  readonly branchId: string
  readonly allOf: readonly CapabilityRefV1[]
}

interface CapabilityRequirementV1 {
  readonly anyOf: readonly CapabilityBranchV1[]
}

interface CapabilityBindingV1 extends CapabilityRefV1 {
  readonly branchId: string
  readonly digest: string
  readonly source: 'policy'
}

interface AuthorityBindingV1 {
  readonly capabilityName: string
  readonly providerModule: string
  readonly authorityVersion: 1
  readonly authorityDigest: string
  readonly constraints: Readonly<Record<string, JsonValueV1>>
}
```

约束不是通用 Record 语义；每个 name/version 必须由[附录 A.1](capability-definitions.md)的可信 Definition Registry 定义 typed Schema、normalize、meet、satisfies 与 authorityProjector。`anyOf` 按 Registry 冻结顺序选择第一个完整满足的 `allOf`；选择结果在 admission 时冻结，Provider 只收到最小 binding。

## A.4 权威交集与错误优先级

有效授权始终是：

```text
Host hard cap ∩ SandboxPolicy ∩ selected Capability branch
  ∩ CanonicalResource constraints ∩ Provider reauthorization
```

Policy/Capability 不满足在 Host Middleware 前失败；Middleware 不得恢复。错误优先级固定为 policy version → invalid resource/arguments → policy denied → capability denied → middleware terminal → provider terminal → result validation。这样 Host 不能用短路结果掩盖不可恢复的系统拒绝。
