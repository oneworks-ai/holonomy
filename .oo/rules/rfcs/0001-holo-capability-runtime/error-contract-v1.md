# RFC-0001 附录 E.1：Guest 错误合同

[返回 Network 与错误](network-and-node-errors.md)

## E.1.1 Closed terminal domains

```ts
type RuntimeAdmissionCodeV1 =
  | 'runtime.configuration_invalid'
  | 'runtime.policy_version_unsupported'
  | 'runtime.binding_unavailable'

type InternalCapabilityCodeV1 =
  | 'policy.denied'
  | 'capability.denied'
  | 'argument.invalid'
  | 'resource.invalid'
  | 'resource.not_found'
  | 'resource.exists'
  | 'resource.stale'
  | 'resource.handle_limit'
  | 'resource.byte_limit'
  | 'resource.event_limit'
  | 'resource.cross_root'
  | 'middleware.permission_denied'
  | 'middleware.timeout'
  | 'middleware.failed'
  | 'middleware.invalid_result'
  | 'provider.permission_denied'
  | 'provider.unavailable'
  | 'provider.timeout'
  | 'provider.connection_refused'
  | 'provider.protocol_error'
  | 'provider.quota'
  | 'result.invalid'
  | 'runtime.cancelled'
  | 'runtime.generation_stale'
  | 'runtime.async_required'

interface InternalCapabilityErrorV1 {
  readonly code: InternalCapabilityCodeV1
  readonly operation: string
  readonly semanticResourceDigest?: string
  readonly retryable: boolean
  readonly terminal: true
}
```

Policy version/configuration/initial binding 在 Guest Realm 创建前由 Runtime Factory/Service拥有，只能生成 `RuntimeAdmissionCodeV1`，不走 Guest facade：invalid creation spec=`runtime.configuration_invalid`，未知Policy schema=`runtime.policy_version_unsupported`，缺失Host binding=`runtime.binding_unavailable`。Internal terminal无platform message、native path/stack、Context或原始参数。每次调用只生成一次；facade不重新执行。Host throw=`middleware.failed`，deadline=`middleware.timeout`，Host明确拒绝=`middleware.permission_denied`。

## E.1.2 Guest closed code与Schema

```ts
type NodeGuestErrorCodeV1 =
  | 'EACCES'
  | 'EINVAL'
  | 'ENOENT'
  | 'EEXIST'
  | 'EBADF'
  | 'EMFILE'
  | 'EFBIG'
  | 'ENOSPC'
  | 'ETIMEDOUT'
  | 'EIO'
  | 'EPROTO'
  | 'ECONNREFUSED'
  | 'ABORT_ERR'
  | 'ENOSYS'
  | 'EXDEV'
  | 'ERR_ACCESS_DENIED'
  | 'ERR_INVALID_ARG_VALUE'
  | 'ERR_INVALID_STATE'
  | 'ERR_SYSTEM_ERROR'
  | 'ERR_OUT_OF_RANGE'
  | 'ERR_OPERATION_TIMEOUT'
  | 'ERR_OPERATION_FAILED'
  | 'ERR_INVALID_RETURN_VALUE'
  | 'ERR_METHOD_NOT_IMPLEMENTED'
  | 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

type HoloGuestErrorCodeV1 =
  | 'holo.policy_denied'
  | 'holo.capability_denied'
  | 'holo.permission_denied'
  | 'holo.invalid_arguments'
  | 'holo.not_found'
  | 'holo.already_exists'
  | 'holo.generation_stale'
  | 'holo.resource_exhausted'
  | 'holo.operation_timeout'
  | 'holo.middleware_failed'
  | 'holo.invalid_result'
  | 'holo.provider_unavailable'
  | 'holo.connection_refused'
  | 'holo.protocol_error'
  | 'holo.operation_cancelled'
  | 'holo.async_required'

interface NodeErrorSnapshotV1 extends Error {
  readonly name: 'Error' | 'AbortError' | 'TypeError'
  readonly code: NodeGuestErrorCodeV1
  readonly path?: VirtualPathV1
  readonly syscall?: string
  readonly retryable: boolean
}

interface HoloErrorV1 extends Error {
  readonly name: 'HoloError'
  readonly code: HoloGuestErrorCodeV1
  readonly operation: string
  readonly retryable: boolean
}
```

`NodeErrorSnapshotV1` 是 Guest Realm Error/AbortError/TypeError，包含 closed `code`、可选virtual `path`、Registry固定`syscall`和`retryable`。`HoloErrorV1` 是 Guest Realm HoloError，包含closed `code`、operation和retryable。name/message non-enumerable；其余列出的字段 enumerable、non-writable、non-configurable；stack不跨Host。固定message不含原始资源。所有Node family（包括`node:child_process`）只使用下一节的machine mapping。

## E.1.3 唯一 machine mapping

`CAPABILITY_ERROR_MAP_V1` 是 machine schema 的单一owner；下表由其生成，Markdown不维护第二份自由文本选择：

| Internal                                                | node:fs              | node:os/process                    | holo:*                    |
| ------------------------------------------------------- | -------------------- | ---------------------------------- | ------------------------- |
| policy.denied                                           | EACCES/Error         | ERR_ACCESS_DENIED/Error            | holo.policy_denied        |
| capability.denied                                       | EACCES/Error         | ERR_ACCESS_DENIED/Error            | holo.capability_denied    |
| middleware.permission_denied/provider.permission_denied | EACCES/Error         | ERR_ACCESS_DENIED/Error            | holo.permission_denied    |
| argument.invalid/resource.invalid                       | EINVAL/TypeError     | ERR_INVALID_ARG_VALUE/TypeError    | holo.invalid_arguments    |
| resource.not_found                                      | ENOENT/Error         | ERR_INVALID_STATE/Error            | holo.not_found            |
| resource.exists                                         | EEXIST/Error         | ERR_INVALID_STATE/Error            | holo.already_exists       |
| resource.stale/runtime.generation_stale                 | EBADF/Error          | ERR_INVALID_STATE/Error            | holo.generation_stale     |
| resource.handle_limit                                   | EMFILE/Error         | ERR_SYSTEM_ERROR/Error             | holo.resource_exhausted   |
| resource.byte_limit/provider.quota                      | EFBIG/Error          | ERR_OUT_OF_RANGE/Error             | holo.resource_exhausted   |
| resource.event_limit                                    | ENOSPC/Error         | ERR_SYSTEM_ERROR/Error             | holo.resource_exhausted   |
| resource.cross_root                                     | EXDEV/Error          | ERR_INVALID_ARG_VALUE/Error        | holo.invalid_arguments    |
| middleware.timeout/provider.timeout                     | ETIMEDOUT/Error      | ERR_OPERATION_TIMEOUT/Error        | holo.operation_timeout    |
| middleware.failed                                       | EIO/Error            | ERR_OPERATION_FAILED/Error         | holo.middleware_failed    |
| middleware.invalid_result/result.invalid                | EPROTO/Error         | ERR_INVALID_RETURN_VALUE/TypeError | holo.invalid_result       |
| provider.unavailable                                    | EIO/Error            | ERR_SYSTEM_ERROR/Error             | holo.provider_unavailable |
| provider.connection_refused                             | ECONNREFUSED/Error   | ERR_SYSTEM_ERROR/Error             | holo.connection_refused   |
| provider.protocol_error                                 | EPROTO/Error         | ERR_SYSTEM_ERROR/Error             | holo.protocol_error       |
| runtime.cancelled                                       | ABORT_ERR/AbortError | ABORT_ERR/AbortError               | holo.operation_cancelled  |
| runtime.async_required                                  | ENOSYS/Error         | ERR_METHOD_NOT_IMPLEMENTED/Error   | holo.async_required       |

Network Fetch使用Web-compatible TypeError/AbortError facade。固定message=`${code}: Holonomy ${operation} failed`；AbortError=`The operation was aborted`。Host Guest-safe自定义错误只允许宿主业务facade，不能改变Node code。

`CAPABILITY_ERROR_MAP_V1.childProcess` 是同一machine owner的operation-family投影，不是第二张可选择的映射：

| Internal condition                                        | node:child_process code/class           |
| --------------------------------------------------------- | --------------------------------------- |
| policy.denied/capability.denied/permission_denied         | EACCES/Error                            |
| argument.invalid/resource.invalid/resource.cross_root     | EINVAL/TypeError                        |
| resource.not_found                                        | ENOENT/Error                            |
| resource.exists/resource.stale/generation_stale           | ERR_INVALID_STATE/Error                 |
| resource.handle_limit/resource.event_limit                | EMFILE/Error                            |
| resource.byte_limit/provider.quota during captured output | ERR_CHILD_PROCESS_STDIO_MAXBUFFER/Error |
| resource.byte_limit/provider.quota during stdin.write     | EFBIG/Error                             |
| middleware.timeout/provider.timeout                       | ETIMEDOUT/Error                         |
| middleware.failed/provider.unavailable                    | EIO/Error                               |
| middleware.invalid_result/result.invalid/protocol_error   | EPROTO/Error                            |
| provider.connection_refused                               | ECONNREFUSED/Error                      |
| runtime.cancelled                                         | ABORT_ERR/AbortError                    |
| runtime.async_required                                    | ENOSYS/Error                            |

`permission_denied`代表`middleware.permission_denied|provider.permission_denied`；`generation_stale`代表`runtime.generation_stale`；`protocol_error`代表`provider.protocol_error`。未出现在上述child-process投影中的internal code不能落入自由选择：生成器必须先使用主表同一row的`node:os/process`映射，再由本投影中更精确的operation condition覆盖。unknown executable必须产生`resource.not_found`，captured stdout/stderr cap必须产生带phase的`resource.byte_limit`，从而唯一得到上表code。

## E.1.4 Delivery与门禁

- sync：failure throw exact Guest Realm error，success直接返回Registry result。
- callback：按 `HoloModuleOperationV1.delivery` 的success/failure schema exactly-once异步投递。默认failure精确一个`error`实参；只有Registry显式`errorAndTuple`的Node member可以追加已验证tuple。
- Promise：success resolve result，failure reject exact Guest Realm error。

三入口共享internal terminal、semantic resource、retryable与mapping。machine vectors exhaustive遍历closed internal code并断言class/name/message/code/descriptors/path/syscall；逐operation断言callback void/result/multi-result `arguments.length`。TypeScript exhaustive switch、Schema unknown code拒绝与全RFC `holo.*`/ERR_/errno literal一致性是M2门禁。
