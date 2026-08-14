# RFC-0001 附录 B.1：Resolved Resource Challenge

[返回资源与快照合同](resources-and-snapshots.md)

Provider 在真实执行前发现 resolved identity 时，不能自行继续，也不能重入原 Middleware `next()`；它必须通过 Broker 的 challenge 子准入。

## B.1.1 合同

```ts
interface ResolvedResourceChallengeBaseV1 {
  readonly schemaVersion: 1
  readonly challengeId: string
  readonly parentRequestId: string
  readonly sequence: number
}

type ResolvedResourceChallengeV1 =
  | Readonly<
    ResolvedResourceChallengeBaseV1 & {
      reason: 'networkAddress'
      requested: NetworkResourceV1
      resolved: NetworkResourceV1
      evidence: ResolutionEvidenceBindingV1 & { kind: 'networkAddress' }
    }
  >
  | Readonly<
    ResolvedResourceChallengeBaseV1 & {
      reason: 'filesystemTarget'
      requested: FilesystemResourceV1
      resolved: FilesystemResourceV1
      evidence: ResolutionEvidenceBindingV1 & { kind: 'filesystemTarget' }
    }
  >
  | Readonly<
    ResolvedResourceChallengeBaseV1 & {
      reason: 'opaqueRebind'
      requested: OpaqueHandleResourceV1
      resolved: OpaqueHandleResourceV1
      evidence: ResolutionEvidenceBindingV1 & { kind: 'opaqueIdentity' }
    }
  >

type ResolutionEvidenceV1 =
  | Readonly<{
    kind: 'networkAddress'
    addresses: readonly string[]
    resolverGeneration: number
    expiresAtMonotonicMs: number
  }>
  | Readonly<{
    kind: 'filesystemTarget'
    rootId: string
    ancestorIdentityDigests: readonly string[]
    targetIdentityDigest: string
    targetType: 'file' | 'directory' | 'symlink' | 'missing'
  }>
  | Readonly<{
    kind: 'opaqueIdentity'
    bridgeIdentityDigest: string
    rightsDigest: string
    generation: number
  }>

interface ResolutionEvidenceBindingV1 {
  readonly bindingId: string
  readonly evidenceDigest: string
  readonly kind: ResolutionEvidenceV1['kind']
}

interface ResolutionAdmissionTokenV1 {
  readonly tokenId: string
  readonly parentRequestId: string
  readonly challengeId: string
  readonly sequence: number
  readonly generation: number
  readonly requestedSemanticDigest: string
  readonly resolvedSemanticDigest: string
  readonly invocationBindingDigest: string
  readonly evidenceDigest: string
  readonly expiresAtMonotonicMs: number
}
```

evidence 是 Host-only、有界、无 native path 的 typed own-data snapshot。Broker 通过可信 evidence store 以 bindingId读取exact object并复算 digest；业务 Middleware 只见 requested/resolved semantic resource，不见 DNS/handle evidence。evidence不进入 Guest、普通日志、CDP 或 Grant key。token 是 Provider-only opaque identity。

strict Schema 以 `reason` 为 discriminant并同时约束 requested/resolved/evidence kind。Network challenge要求 requested/resolved semantic resource字节相同；地址只在evidence。Filesystem要求同rootId，resolved只可改变pathSegments/semantic digest。Opaque要求resourceType、generation、rightsDigest和Bridge semantic identity全相同，任何变化拒绝。token签发与Provider execute都重新验证这组映射，不能只比较 evidenceDigest。

## B.1.2 状态机

```text
providerPreflight
  → challenge(sequence N, sideEffects=resolutionOnly)
    → systemPolicy
      → optional hostResolutionMiddleware
        → admitted token | denied/cancelled/timedOut
          → providerExecute(token)
```

`resolutionOnly` 可以执行解析所必需的 metadata lookup、lstat/safe directory walk 或 DNS，但不得打开目标连接、读取/写入业务文件、发送请求或发布 Guest-visible side effect。Provider 在 challenge 前必须报告 side-effect counter=0（不计 resolution evidence）。

原 Invocation Middleware 的 `next()` 只调用一次并保持 pending。challenge 使用新的 `subrequestId` 和独立 resolution Middleware chain，因此不重复调用原 continuation。deny/timeout/cancel 会清理 preflight state、关闭临时 descriptor/解析结果并终止父调用。

## B.1.3 哪些层重跑

- DNS/IP：semantic Network resource 不变，只重跑不可移除 system network Policy 和 Provider private-address authority；不调用业务 Host Middleware。地址列表 canonicalize、去重、按 binary bytes排序，最多64项；空/超限/解析失败拒绝。IPv4-mapped IPv6按底层IPv4分类，zone identifier拒绝；只要任一地址违反private policy，整个resolution拒绝。
- filesystem resolved target：只要 semantic target/root/rights 变化，就重跑 system filesystem Policy 和 Host resolution Middleware；Host 可用 resolved semantic digest 做决定。
- opaque handle rebind：只能验证相同 Bridge identity/generation/rights；任何变化直接拒绝，不向 Host 询问。
- HTTP redirect：不是 Provider challenge。Fetch 为新 URL 创建 hop+1 的完整 top-level admission，重新运行 Policy、Host Middleware 和 Network Rules。

Provider 每次执行都必须提交 exact token 与当前 evidence digest。Network connect前的地址必须仍在 admitted set且evidence未过 resolver expiry；DNS TTL/generation/地址变化使旧 token 失效并产生 sequence N+1 challenge。Filesystem execute前重验 ancestor/target identity；Opaque重验Bridge identity。超过 hard challenge count拒绝。token 在 deadline、Abort、stop/restart、Host disconnect 或 generation 变化时失效。

Host resolution Middleware 使用 initial Middleware snapshot中 `phase='resolved'` 的 registration；只有filesystem semantic target变化会匹配。live registry 仍只影响后续 challenge。DNS evidence永不进入该层。

## B.1.4 固定反例

测试覆盖：challenge 前业务 sideEffects=0、reason/resource/evidence cross-kind mismatch、同kind semantic tamper、双重 symlink/rename 变化、DNS空/超限/mixed public-private/mapped/zone/TTL/rebinding、resolver失败、stale/重复 token、evidence tamper、deny cleanup、timeout/cancel、Provider绕过challenge、原 Middleware next仍只一次、redirect新hop，以及 semantic digest稳定而invocation binding每次不同。
