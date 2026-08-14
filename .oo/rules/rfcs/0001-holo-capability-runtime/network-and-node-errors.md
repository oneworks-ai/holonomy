# RFC-0001 附录 E：Network Broker 与 Guest 错误

[返回 RFC 总览](../0001-holo-capability-runtime.md)

## E.1 Network operation

Fetch 语义仍由 JavaScript Runtime 拥有；Broker 不重演 redirect、Response/body 或 Abort 语义。稳定 operations：

```text
network.fetch.request
network.fetch.redirect
network.response.metadata.read
network.response.body.read
network.websocket.connect        # v1 capability matrix 默认 unsupported
```

DNS、socket、TLS 和 resolved IP 只属于 Provider reauthorization 与旁路 Observer，不作为 Host Middleware 可修改的 Fetch 语义。

每个逻辑 Fetch 使用一个 `logicalRequestId`；每个 redirect hop 使用递增 hop 和新的 `NetworkResourceV1`。Middleware 可见 method、canonical origin/path、hop、有界 header-name 集合和 query/body/header digest；Authorization、Proxy-Authorization、Cookie、Set-Cookie、常见敏感 query 和正文默认不进入 arguments、Context、日志或 CDP。读取敏感正文需要独立 bounded Host-only reader capability。

## E.2 固定执行顺序

```text
Fetch canonical request
  → Network SandboxPolicy / selected capability
  → system network middleware
  → Host Invocation Middleware
  → immutable Network Rules revision
       respond → validate mock response → source=mock
       fail → stable network terminal
       passthrough → real Provider reauthorization → source=real
  → response/body quota and Guest Realm reconstruction
```

- `mockOnly` 允许 mock terminal，禁止 passthrough；`restricted` 仍受 origin/scheme/private-network/limit ceiling。
- Host Middleware 可以 deny、调用 next 或返回符合 response Schema 的短路 mock；短路不产生真实 Network authority。
- Network Rules snapshot 在逻辑请求 admission 时冻结；redirect hop 重新准入 URL，但保持同一 rules revision。
- mock 不得扩大 real-network capability；passthrough 前 Provider 仍按 canonical URL、method、raw bounded headers、DNS 后全部地址、连接槽和 bytes 重验。
- redirect 目标、method rewrite 和 body replay 由 Fetch 决定；每一 hop 在打开连接前重新跑 Policy 与 Host Middleware。
- deadline、Abort 和 stop/restart 竞争使用 Runtime 的第一终态；Middleware/Rules/Provider 的 late terminal 不得复活请求。

逐member的mode、interception、capability、resource和result由[附录 E.3](network-operation-registry.md)唯一冻结。WebSocket 如果未来从 capability matrix 开放，必须使用独立 connect operation、message/queue quotas、redirect/proxy policy 和 generation-bound resource；在此之前按E.3固定TypeError且不走Host Middleware、Provider或ambient WebSocket。

## E.3 Observer 与 CDP

Network Observer 接收 request→redirect*→response→data*→exactly-one terminal，事件携带 `source: real | mock`。业务 Middleware 不接收 DNS/IP/TLS 细节；这些只进入受限诊断。CDP body preview 仍按 per-response/process/service/TTL 限额，超限只令 body unavailable，不影响 Fetch。

固定 E2E 至少覆盖：首请求 real、mock response、mockOnly passthrough 拒绝、redirect 新 origin、private IP 重验、敏感 header/query/body 脱敏、abort、rules revision snapshot，以及 CDP real/mock source。

## E.4 内部错误

closed internal code、Node/Holo Error own-property Schema、固定 message、逐 family 翻译和 callback 参数由[附录 E.1](error-contract-v1.md)冻结。Policy hard deny、Capability deny和 Host permission deny 是不同 internal code；`node:*` 可以统一映射为 Node `EACCES`，`holo:*` 不得把它们合并。
