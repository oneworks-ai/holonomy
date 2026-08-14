# RFC-0001 附录 E.3：Network Operation Registry v1

[返回 Network Broker](network-and-node-errors.md)

```ts
type NetworkOperationV1 =
  | 'network.fetch.request'
  | 'network.fetch.redirect'
  | 'network.response.metadata.read'
  | 'network.response.body.read'
  | 'network.websocket.connect'

interface NetworkRedirectInvocationV1 {
  readonly logicalRequestId: string
  readonly fromHop: number
  readonly toHop: number
  readonly status: 301 | 302 | 303 | 307 | 308
  readonly fromRequest: NetworkInvocationSnapshotV1
  readonly toRequest: NetworkInvocationSnapshotV1
  readonly methodRewritten: boolean
  readonly bodyReplay: 'none' | 'same-buffered-body'
}

interface NetworkResponseMetadataV1 {
  readonly responseId: string
  readonly logicalRequestId: string
  readonly hop: number
  readonly generation: number
  readonly status: number
  readonly statusText: string
  readonly headers: readonly NetworkHeaderViewV1[]
  readonly url: string
  readonly redirected: boolean
  readonly source: 'real' | 'mock'
}

interface NetworkResponseBodyBindingV1 {
  readonly readerId: string
  readonly responseId: string
  readonly logicalRequestId: string
  readonly hop: number
  readonly generation: number
  readonly bodyDigest?: string
  readonly consumed: boolean
}
```

## E.3.1 Per-member Registry

| Facade/member                                        | Mode    | Operation                      | Interception | Capability / authority                 | Args → result                          |
| ---------------------------------------------------- | ------- | ------------------------------ | ------------ | -------------------------------------- | -------------------------------------- |
| global/fetch                                         | promise | network.fetch.request          | host         | host.network.mock OR host.network.http | NetworkInvocationSnapshotV1 → Response |
| runtime/followRedirect                               | promise | network.fetch.redirect         | host         | inherited exact request branch         | NetworkRedirectInvocationV1 → void     |
| Response/status,statusText,ok,headers,url,redirected | sync    | network.response.metadata.read | systemOnly   | inherited response binding             | empty → metadata field                 |
| Response/text                                        | promise | network.response.body.read     | systemOnly   | inherited response binding             | empty → string                         |
| Response/json                                        | promise | network.response.body.read     | systemOnly   | inherited response binding             | empty → JsonValueV1                    |
| Response/arrayBuffer                                 | promise | network.response.body.read     | systemOnly   | inherited response binding             | empty → ArrayBuffer                    |
| Response/bytes                                       | promise | network.response.body.read     | systemOnly   | inherited response binding             | empty → Uint8Array                     |
| Response/clone                                       | sync    | network.response.body.read     | systemOnly   | inherited response binding             | empty → Response                       |
| global/WebSocket                                     | sync    | network.websocket.connect      | host         | unavailable in SandboxPolicyV2         | URL+protocols → never                  |

所有row都是`kind=invoke`，property getters除外为`kind=read`；没有callback入口。每row生成完整`HoloModuleOperationV1`，不能在Fetch/Response实现中硬编码跳过Registry。公开RequestInfo/Init先经过descriptor-safe snapshot与E.2规范化，Registry 的 `argsSchemaId` 精确指向冻结后的`NetworkInvocationSnapshotV1`；首请求和redirect request使用`NetworkResourceV1`；Response rows使用generation-bound opaque response/reader resource。RequestInfo v1只接受string/受信Facade Request snapshot，不读取Guest URL exotic。

`host.network.mock OR host.network.http` 是两个单capability branch，按Policy选择并冻结；mock branch永远没有real Provider authority。redirect和Response只能继承同一逻辑请求已选择的branch/digest，不能重新选择更宽分支。

## E.3.2 Redirect 两阶段

hop 0只执行`network.fetch.request`。收到redirect response后，Fetch在任何新连接或body replay前执行：

```text
canonicalize target + decide method/body replay
  → network.fetch.redirect admission (Host interception; no Network Rules)
  → network.fetch.request admission for hop+1 (Host interception + frozen Rules)
  → DNS resolution challenge + Provider reauthorization
  → connect
```

两次admission共享logicalRequestId，但有不同invocation binding digest和operation。redirect operation让Host观察/拒绝跳转语义，不能改写target/method/body或返回mock；新hop request允许E.2 synthetic terminal。任一deny/timeout/cancel使两条链exactly-once终止，后一阶段和connect side effects为零。redirect超过Policy maxRedirects在两条Host chain之前由system Policy拒绝。

`fromRequest` 是上一跳已经准入的完整、冻结 snapshot，不是调用方重新拼装的 resource。Kernel 必须验证 `307/308` 不改 method 且仅在上一跳 body 为 `buffered` 时使用 `same-buffered-body`；`303` 除 GET/HEAD 外改为 GET 并丢弃 body；`301/302` 只按 v1 固定规则将 POST 改为 GET 并丢弃 body。`methodRewritten`、`bodyReplay`、下一跳 method/body 与这套规则任一不一致都在第二次 Host Middleware 或 Provider 之前失败。

## E.3.3 Response reader

Response创建时Kernel生成`NetworkResponseBodyBindingV1`，绑定process/generation/logicalRequestId/hop/responseId和exact request authority。`text/json/arrayBuffer/bytes`消费接收者的reader exactly once；第二次或交叉response readerId返回Web-compatible TypeError。`clone()`只在原reader未消费时生成独立readerId；clone与原对象共享底层credited stream terminal，但各自按Policy计量与复制。

body method的decode/JSON parse失败只终止对应reader，不复活或重新Fetch。cancel、stop、restart、response terminal或generation变化使binding stale；late chunk不可进入新generation。metadata getter不消费body。Host Middleware不能注册response operation matcher。

## E.3.4 WebSocket 与 machine vectors

SandboxPolicyV2没有WebSocket capability，故`network.websocket.connect` row是明确unsupported facade：构造在任何Host Middleware/Provider前同步抛固定`TypeError`，message=`Holonomy WebSocket is unsupported by SandboxPolicyV2`。未来开放必须新增Policy schemaVersion、Capability Definition和message/queue resource合同，不能复用HTTP authority。

machine vectors逐row校验member、mode、kind、operation、interception、capability branch、resource和result Schema；另覆盖redirect两阶段顺序/sideEffects=0、requestId相同但binding digest不同、reader single-consume/clone/stale generation，以及WebSocket exact error且Middleware/Provider调用数为零。
