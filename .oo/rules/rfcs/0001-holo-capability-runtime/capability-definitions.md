# RFC-0001 附录 A.1：Capability Definition Registry

[返回 Policy 与 Capability](policy-and-capabilities.md)

```ts
type BuiltInCapabilityNameV1 =
  | 'host.fs'
  | 'host.network.mock'
  | 'host.network.http'
  | 'host.network.request-body.read'
  | 'host.device.summary'
  | 'host.device.state'
  | 'host.device.sensitive'
  | 'host.system.basic'
  | 'host.system.version'
  | 'host.system.compute'
  | 'host.system.memory'
  | 'host.system.runtime'
  | 'host.system.identity'
  | 'host.system.network-topology'
  | 'host.system.process-identity'
  | 'host.diagnostics.source.read'
  | 'host.storage.credential'
  | 'host.process.execute'
  | 'host.process.shell'
  | 'host.process.signal'
  | 'host.process.network'
```

```ts
interface CapabilityDefinitionV1<C, A> {
  readonly name: BuiltInCapabilityNameV1
  readonly version: 1
  readonly constraintSchemaId: string
  normalize(value: unknown): Readonly<C>
  meet(left: Readonly<C>, right: Readonly<C>): Readonly<C> | null
  satisfies(available: Readonly<C>, required: Readonly<C>): boolean
  projectAuthority(value: Readonly<C>): Readonly<A>
}
```

只有 Kernel 内建或可信 Embedder 在 Runtime 创建前注册 definition；Guest/远程 launch 只能引用已注册 name/version。Registry 在 generation 创建时冻结。normalize 必须是 accessor-free typed snapshot，unknown key/version 拒绝。

## A.1.1 内建约束

```ts
interface FsCapabilityConstraintsV1 {
  readonly roots: readonly Readonly<{
    rootId: string
    pathPrefixSegments: readonly string[]
    rights: readonly FilesystemRightV2[]
  }>[]
  readonly limits: FilesystemLimitsV2
}
interface NetworkCapabilityConstraintsV1 {
  readonly mode: 'mockOnly' | 'restricted'
  readonly origins: readonly string[]
  readonly schemes: readonly ('http' | 'https')[]
  readonly allowPrivateNetwork: boolean
  readonly inspectRequestBodyBytes: number
  readonly limits: Readonly<Record<NetworkLimitNameV2, number>>
}
interface DeviceCapabilityConstraintsV1 {
  readonly operations: readonly DeviceOperationV1[]
  readonly maxPrivacyTier: 0 | 1 | 2 | 3
  readonly maxPrecision: 'coarse' | 'standard' | 'exact'
  readonly maxQueuedEvents: number
}
interface SystemCapabilityConstraintsV1 {
  readonly fields: readonly SystemInformationFieldV1[]
  readonly modes: readonly SystemExposedProjectionModeV1[]
  readonly maxPrecision: 'redacted' | 'coarse' | 'exact'
}
interface CredentialCapabilityConstraintsV1 {
  readonly stores: readonly string[]
  readonly usages: readonly ('httpAuthorization' | 'gitHttp')[]
}
```

内建definition names只来自`BuiltInCapabilityNameV1`。diagnostics source constraints只有`maxReadBytes/maxReads` numeric ceilings。Git module operation使用`host.fs + host.network.http + host.storage.credential`的`allOf`；进程按operation组合`host.process.execute`、shell/signal/network与所引用的FS/credential authority，不把authority合并成无类型Record。Process typed constraints由[附录 J](process-and-linux-backend.md)唯一拥有。

## A.1.2 偏序、meet 与 satisfies

- 集合字段 canonical sort/dedupe；available 满足 required 当且仅当 available 是 required 的 superset。
- path prefix 按 segment 比较；available prefix 必须等于或是 required 的祖先。相同 root 的 meet 取更窄 prefix、rights 交集。
- numeric limit 表示最大允许量；available 满足 required 当 `required <= available`，meet 取较小值。
- origins 必须是 canonical origin exact set；schemes 是集合；private-network 用 `false < true`，meet 用 AND。
- Network mode：`mockOnly` 与 `restricted` 是不同 capability definition，不相互满足。real Provider 永不消费 mock binding。
- Device privacy tier 使用 `0 < 1 < 2 < 3`。Device precision 使用独立 lattice `redacted(0) < coarse(1) < standard(2) < exact(3)`；Policy/Capability 可请求上限只允许 coarse/standard/exact，Provider 可以返回更低的 redacted reading。available ceiling 满足 required 当 rank 不低于 required，meet 取较低 rank。
- System precision 使用不同 lattice `redacted(0) < coarse(1) < exact(2)`；normalize/meet/satisfies 只能在同一个具体的System capability definition 内进行。Device 的 standard 不得被投射或比较成 System precision，跨 definition value稳定拒绝。
- credential store/usages 使用 exact normalized identifier 集合；不包含 secret value。

同一 `allOf` 中重复 name/version 先按 definition meet；null 表示矛盾，整个 branch 无效。空 `anyOf`、空 `allOf`、重复 branchId、unknown key/version 一律拒绝。多个 branch 可满足时按声明顺序选择第一个，不能按平台偏好选择。

## A.1.3 Digest 与 authority

constraint semantic digest 覆盖 `{name,version,normalizedConstraints}` canonical JSON。selected binding digest 覆盖 semantic digest、branchId、policyDigest、processId、generation。authority digest 覆盖 provider module、projected minimal authority、principal、generation 和 binding digest。

`projectAuthority` 删除 Provider 不需要的字段：FS Provider只得 selected root/prefix/rights/limits；real Network只得 canonical origins/schemes/private/limits；mock Router只得 mock mode/limits；Device/System只得 selected operations/fields/precision；credential Provider只得 store/usage handle authority。

## A.1.4 固定 vectors

共享 vectors 覆盖 rights/origin/field 集合包含、numeric ceiling、path segment ancestry、canonical origin、Device coarse/standard/exact与redacted降级、System redacted/coarse/exact、跨definition precision拒绝、privacy tier、private boolean、重复 capability meet/冲突、空 branch、unknown key/version、分支顺序，以及每个 Provider authority projection 不含其他 binding。
