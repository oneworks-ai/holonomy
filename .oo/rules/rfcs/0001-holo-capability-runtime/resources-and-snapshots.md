# RFC-0001 附录 B：CanonicalResource 与跨 Realm 快照

[返回 RFC 总览](../0001-holo-capability-runtime.md)

## B.1 CanonicalResource v1

```ts
interface CanonicalResourceBaseV1 {
  readonly schemaVersion: 1
  readonly kind:
    | 'filesystem'
    | 'network'
    | 'deviceField'
    | 'opaqueHandle'
    | 'processExecutable'
    | 'processInstance'
    | 'systemField'
  readonly semanticId: string
  readonly semanticResourceDigest: string
  readonly display: Readonly<{ label: string }>
}

interface FilesystemResourceV1 extends CanonicalResourceBaseV1 {
  readonly kind: 'filesystem'
  readonly rootId: string
  readonly pathSegments: readonly string[]
  readonly virtualUrl: `holo-fs://${string}/${string}`
}

interface NetworkResourceV1 extends CanonicalResourceBaseV1 {
  readonly kind: 'network'
  readonly method: string
  readonly origin: string
  readonly pathname: string
  readonly queryDigest?: string
}

interface DeviceFieldResourceV1 extends CanonicalResourceBaseV1 {
  readonly kind: 'deviceField'
  readonly operation: DeviceOperationV1
  readonly field: string
  readonly privacyTier: 0 | 1 | 2 | 3
}

interface SystemInformationFieldResourceV1 extends CanonicalResourceBaseV1 {
  readonly kind: 'systemField'
  readonly field: SystemInformationFieldV1
}

interface OpaqueHandleResourceV1 extends CanonicalResourceBaseV1 {
  readonly kind: 'opaqueHandle'
  readonly resourceType: string
  readonly generation: number
  readonly rightsDigest: string
}

type CanonicalResourceV1 =
  | FilesystemResourceV1
  | NetworkResourceV1
  | DeviceFieldResourceV1
  | OpaqueHandleResourceV1
  | ProcessExecutableResourceV1
  | ProcessInstanceResourceV1
  | SystemInformationFieldResourceV1

interface ResourceCanonicalizerV1<Args> {
  canonicalize(
    operation: string,
    argumentSnapshot: InvocationArgumentSnapshotV1<Args>
  ): CanonicalResourceV1
}

interface InvocationResourceBindingV1 {
  readonly requestId: string
  readonly subrequestId?: string
  readonly generation: number
  readonly hop?: number
  readonly semanticResourceDigest: string
  readonly invocationBindingDigest: string
}
```

`display` 是有界 Guest-safe/UI-safe 文本，不是授权依据。Host-only authority 只存在于 `AuthorityBindingV1`，不得塞进 display、Guest error、日志或 Inspector。`semanticId` 与两个 digest 由系统 canonicalizer 构造，Guest 不能提供。

- semantic digest 只覆盖 `schemaVersion/kind` 和 resource-specific semantic fields，不含 display、requestId、subrequestId、generation 或 hop；Host 可选择把它作为 Grant key 的输入。
- invocation binding digest 覆盖 semantic digest、processId、generation、requestId、subrequestId、hop、operation、capability/authority digest；Provider token 和资源句柄绑定它。

canonical formula 使用带type tag、UTF-8和lexicographic object-key order的canonical JSON小写SHA-256：

- FS=`['filesystem',rootId,pathSegments]`；Network=`['network',method,origin,pathname,queryDigest|null]`；Device=`['deviceField',operation,field,privacyTier]`；Handle=`['opaqueHandle',resourceType,generation,rightsDigest,bridgeIdentityDigest]`。
- Process program executable=`['processExecutable','program',executableId,argvDigest,cwdSemanticResourceDigest|null,environmentScope,environmentNamesDigest,stdioDigest]`；shell executable=`['processExecutable','shell',shellExecutableId,commandDigest,cwdSemanticResourceDigest|null,environmentScope,environmentNamesDigest,stdioDigest]`。`argvDigest`覆盖有序argv snapshot；`commandDigest`覆盖exact frozen command UTF-8 bytes，不做token猜测或shell重解析；`environmentScope`是Host profile准入后的`runtime|processTree`；environment names按UTF-8排序后摘要，不含value；stdio按有序`pipe|ignore`数组摘要。两种type tag及不同environment scope不可互换或meet。
- Process instance=`['processInstance',executableSemanticResourceDigest,processResourceId,generation]`。`processResourceId`是Kernel生成的有界opaque ID，不是PID；`generation`与parent executable digest防止旧resource复用。
- System field=`['systemField',field]`；field 必须来自 `SystemInformationFieldV1` closed union。

`semanticId`分别是`holo-fs:<root>/<segments>`、canonical network request label、device operation/field、opaque type/id、`process-executable:<executableId>:<digest-prefix>`或`process-instance:<opaque-id>:<generation>`；它是有界可读编码，不能替代digest比较。Process invocation binding另外覆盖processId、Runtime generation、operation、requestId、selected capability/authority/policy digests；Provider token提交完全相同的binding，不接收Guest PID或命令字符串作为授权依据。

## B.2 Canonicalization

Canonicalization 是不可移除的系统步骤，发生在 Host Middleware 之前：

- filesystem：fatal UTF-8；拒绝 NUL、反斜杠、encoded separator、空/`.`/`..` segment、Unicode 非规范形式和 root escape；按 rootId+segments 定义身份，不使用字符串 prefix。
- network：要求 canonical HTTP(S) URL；移除 fragment；拒绝 userinfo、模糊端口/host、encoded separator 与不一致的 percent encoding；query/body 默认只保留有界摘要。
- device：只接受 Registry 中冻结的 operation/field，不接受任意属性名。
- opaque handle：通过 Bridge 精确引用身份解析并绑定 principal、generation、originating call 和 rights；结构相同不代表身份相同。
- process：只接受附录J manifest中的executableId、virtual cwd/mount与固定signal；argv/env先做own-data snapshot并分别摘要，禁止PATH/Host path混淆。

```ts
interface CanonicalResourceMatcherV1 {
  readonly kind?: CanonicalResourceV1['kind']
  readonly rootId?: string
  readonly pathPrefixSegments?: readonly string[]
  readonly origin?: string
  readonly operation?: string
  readonly semanticId?: string
}
```

Matcher 在 canonical fields 上执行 segment/origin exact comparison；不接受任意正则、原始 path prefix 或脚本。

## B.3 requested 与 resolved

每次调用先得到 `requested` resource。现实资源解析可能产生 `resolved` resource：

- filesystem symlink/rename 后的 handle-relative target；
- Network redirect 后的新 URL，以及 Provider DNS 后的 IP authority；
- opaque handle 的当前 generation/rights。

resolved identity 变化必须使用[附录 B.1](resource-resolution.md)的 challenge 子准入，不能重入原 `next()`。Provider 可以重验现实资源，但不得重新解释 Guest 原始字符串作为授权依据。Network DNS/IP 只进入 system Policy/Provider authority/Observer，不把 IP 选择交给业务 Middleware；Fetch redirect 则创建新的 hop admission。

Middleware、Grant key 和审计共享冻结 semantic digest；Provider dispatch/opaque token 使用 invocation binding digest。调用开始后 Guest 修改原参数不会改变两类身份。

## B.4 InvocationArgumentSnapshot v1

```ts
declare const invocationArgumentSnapshotBrand: unique symbol

type InvocationArgumentSnapshotV1<T> = Readonly<T> & {
  readonly [invocationArgumentSnapshotBrand]: true
}

type InvocationResultSnapshotV1<T> = Readonly<T> & {
  readonly [invocationArgumentSnapshotBrand]: true
}

interface TrustedOpaqueBindingV1 {
  readonly bindingId: string
  readonly type: 'resource' | 'callback' | 'abortSignal'
  readonly generation: number
}

type HostOnlyInvocationBindingV1 = Readonly<{
  kind: 'networkRequestBodyReader'
  requestId: string
  bodySha256: string
  reader: NetworkRequestBodyReaderV1
}>
```

系统 snapshotter 只读取 Registry 明确列出的 fixed own data slots。任何 Guest Proxy（含嵌套、Array Proxy、revocable Proxy）在读取 descriptor 前由 Engine/native `IsProxy` 等无回调能力判定并拒绝；不得调用任何 Proxy trap。无法证明 no-callback 的 Engine/类型整体稳定拒绝。

准入算法：

1. Engine/native walker 禁止 Guest reentry，先拒绝所有 Proxy，再从 plain object/array 的 internal own slots 读取固定 data descriptor；不得调用 Guest 可替换的 Object/Reflect/iterator/species。accessor、symbol、exotic prototype 稳定失败。
2. 在深度、键数、数组长度、字符串、二进制和总字节硬限额内复制；循环引用失败。
3. `Uint8Array`/`ArrayBuffer` 通过 Engine internal slot 复制并计量；detached、Shared、Resizable/Growable 形态 v1 拒绝，不读取 constructor/species，不共享 backing store。
4. Error 只保留 Registry 允许的稳定 domain/code；不携带 stack/native message。
5. Guest AbortSignal 转成 Runtime 拥有的可信 signal binding；callback 转成 generation-bound callback id；opaque resource 通过 Bridge identity 解析。
6. 在 Host Realm 以 null-prototype 重建并 deep-freeze，随后才交给 Schema、Middleware 和 Provider。

短路结果和 Provider 结果使用对称流程：Host own-data snapshot → 结果 Schema/配额 → Guest Realm null-prototype 重建与冻结。Host 对象、prototype、thenable 和 getter 永不进入 Guest。

Host-only binding 不属于 `arguments`，不能序列化、持久化、进入审计或被 matcher读取；Broker按 exact request/generation/body digest附加到 Context，调用结束即撤销。

## B.5 固定反例

合同测试必须用每一种 Proxy trap 的 side-effect counter 证明计数为零，并覆盖 getter、嵌套/Array/revocable Proxy、thenable、toJSON、iterator、循环、detached/shared/resizable binary、参数 admission 后突变、callback 重入、旧 AbortSignal、旧 generation handle、encoded path、Unicode/prefix confusion、symlink TOCTOU、redirect authority 变化、program argv与shell command digest不可碰撞，以及 Host 短路结果中的 accessor。
