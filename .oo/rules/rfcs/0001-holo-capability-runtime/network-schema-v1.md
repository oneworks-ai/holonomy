# RFC-0001 附录 E.2：Network Broker Schema v1

[返回 Network Broker](network-and-node-errors.md)

## E.2.1 请求快照

```ts
interface NetworkInvocationSnapshotV1 {
  readonly schemaVersion: 1
  readonly logicalRequestId: string
  readonly hop: number
  readonly method: string
  readonly resource: NetworkResourceV1
  readonly headers: readonly NetworkHeaderViewV1[]
  readonly headerDigest: string
  readonly query: readonly NetworkQueryViewV1[]
  readonly queryDigest: string
  readonly body: NetworkRequestBodyMetadataV1
}
interface NetworkHeaderViewV1 {
  readonly name: string
  readonly index: number
  readonly visibility: 'visible' | 'redacted'
  readonly value?: string
}
interface NetworkQueryViewV1 {
  readonly key: string
  readonly index: number
  readonly visibility: 'visible' | 'redacted'
  readonly value?: string
}
type NetworkRequestBodyMetadataV1 =
  | Readonly<{ kind: 'none'; length: 0 }>
  | Readonly<{
    kind: 'buffered'
    length: number
    sha256: string
  }>
interface NetworkRequestBodyReaderV1 {
  read(): Promise<Uint8Array>
}
```

method 是 uppercase ASCII token。Header name lowercase；value 做 HTTP OWS trim，不合并重复项，按原 entry 顺序编号。Query 用 canonical URL parser 得到有序重复键 multimap，key/value 是 fatal UTF-8 decoded strings；semantic URL 仍保留 canonical percent-encoded pathname。

公开 view digest 使用固定大端 u32 length-prefix bytes，不使用 delimiter 拼接：`u32(1) || field(domain) || u32(count) || (u32(index) || field(nameOrKey) || field(visibility) || field(visibleValueOrEmpty))*`，其中 `field(x)=u32(utf8Length)||utf8Bytes`，domain 分别是 `header`/`query`。`headerDigest` 与 `queryDigest` 必须由 Kernel 对冻结 view 重算并精确相等；任何 entry、顺序、visibility 或 visible value 变化都会失败。body digest 是完整 staged bytes 的小写 SHA-256。Guest request body 在 Provider I/O 前按 `maxRequestBodyBytes` 有界 staging/hash，digest 完成后才进入 Host Middleware。`buffered.length` 是非负 safe integer且 sha256 必须存在；`none` 只能是 length=0且无 sha/reader。v1 不承诺无界 streaming upload。

敏感表版本 `network-sensitive-v1`。Header 至少包含 authorization、proxy-authorization、cookie、set-cookie、x-api-key；query key case-fold 后至少包含 token、access_token、api_key、apikey、key、secret、password、signature、sig、auth、code。敏感 value 从 view 移除；公开 view digest只绑定其有序 redacted marker。原始敏感值只参与 Host-only request authority digest，该 digest进入 invocation binding/token而不进入 snapshot、Guest、CDP、日志或默认 Grant key。fragment 永不进入 snapshot。

## E.2.2 Request body reader

`NetworkInvocationSnapshotV1` 是可序列化、可持久化的 metadata；它永远不含函数、token或 reader。reader 通过 `HoloInvocationContext.hostBindings` 中独立的 `kind=networkRequestBodyReader` Host-only binding交付，并绑定同一 requestId/body sha256。

reader 只有在 Network Policy `requestBodyInspection.access=bounded`、selected `host.network.request-body.read` capability 和 Host hard cap 同时允许且 body length 不超过三者最小值时存在。最大可读 bytes 取 Policy `maxBytes`、capability `inspectRequestBodyBytes` 与 Host hard cap最小值；Runtime累计读取次数还受 `maxReadsPerRuntime` 和Host cap较小值限制。它是 Host-only、generation/request-bound、one-shot token；第二次 read、deadline、Abort、restart 或 Middleware 结束后稳定失败。

read 返回独立 copy，计入每调用/Runtime总量；Middleware 完成后 best-effort zero。正文、copy、digest evidence 不进入 Guest、CDP、普通日志或 Observer。没有 reader 时 Host 只能依据 metadata/digest 决策，不能通过其他 Context 取回正文。

## E.2.3 Synthetic terminal

Network Rules 与 Host Middleware 短路共享同一个 owner 类型：

```ts
type NetworkSyntheticBodyV1 =
  | { readonly kind: 'empty' }
  | { readonly kind: 'utf8'; readonly value: string }
  | { readonly kind: 'base64'; readonly value: string }
  | { readonly kind: 'json'; readonly value: JsonValueV1 }

interface NetworkSyntheticResponseV1 {
  readonly type: 'respond'
  readonly status: number
  readonly headers: readonly (readonly [string, string])[]
  readonly delayMs?: number
  readonly body?: NetworkSyntheticBodyV1
  readonly chunks?: readonly Readonly<{
    delayMs?: number
    body: Exclude<NetworkSyntheticBodyV1, { kind: 'empty' }>
  }>[]
}
interface NetworkSyntheticFailureV1 {
  readonly type: 'fail'
  readonly code: 'connection_refused' | 'timeout' | 'reset' | 'mock_failed'
  readonly delayMs?: number
}
type NetworkSyntheticTerminalV1 =
  | NetworkSyntheticResponseV1
  | NetworkSyntheticFailureV1
```

status 是整数 200–599。Header 使用同一 name/value normalizer，拒绝 connection/transfer-encoding/content-length 等 hop framing 字段；总 entries/bytes 受 response hard cap。body 与 chunks 互斥；base64 必须 canonical；JSON 做 finite snapshot；decoded aggregate bytes、chunk count、单/总 delay 受 Policy/Host cap且可取消。source 由 Kernel 写为 `mock`，owner 内部标记 `middleware|rules`，Host 返回值不能伪造 `real`。所有 synthetic terminal 都先经过结果快照/Schema/quota。

## E.2.4 Response 读取

`network.response.metadata.read` 与 `network.response.body.read` 的 Registry `interception='systemOnly'`：它们进入 Broker 做 resource binding、quota、cancel和结果快照，但 Host Registry 不能为其注册 matcher。请求 admission 已授权该 Response。

Response body 维持 lazy credited resource。clone 创建同一 response resource 的独立 reader binding；每个 reader按相同 terminal/aggregate limits消费复制 chunk，任一慢/取消 reader不改变其他 reader或底层 Fetch terminal。body preview/diagnostics另受 cap，不能成为 Guest成功条件。

## E.2.5 固定 vectors

覆盖重复 header/query、OWS/case、敏感表、ordered query、`none`/`buffered` discriminant与unknown key、staged body hash、reader不进入serialized snapshot、one-shot/Runtime次数/oversize/cancel/zero、synthetic secret/oversize/abort、body/chunks互斥、lazy clone多reader、Host matcher注册systemOnly稳定拒绝，以及Network Rules和Middleware使用相同 terminal validator。

逐Facade/member Registry、redirect两阶段和Response reader identity由[附录 E.3](network-operation-registry.md)冻结，本页不维护第二份operation表。
