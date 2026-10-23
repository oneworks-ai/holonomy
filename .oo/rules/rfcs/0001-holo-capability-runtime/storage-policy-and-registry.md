# RFC-0001 附录 L：Storage Policy 与 Operation Registry

[返回 RFC 总览](../0001-holo-capability-runtime.md)

本附录规定七个 `holo:storage` KV/SQLite Promise operation。现有 `packages/runtime/src/storage/` Facade 仍走 NativeBridge v4 的 `host.storage` v1 transport；Host 使用纯映射 helper 进入同一个 Kernel/Broker，再由 `host.storage` Provider 调 Rust。Credential open/use 和 `host.storage.credential` 保留原合同，本批不宣称可用。

```ts
type StorageOperationV1 =
  | 'storage.kv.delete'
  | 'storage.kv.get'
  | 'storage.kv.list'
  | 'storage.kv.set'
  | 'storage.sqlite.execute'
  | 'storage.sqlite.query'
  | 'storage.sqlite.transaction'

interface StorageLimitsV2 {
  readonly maxDatabaseNameBytes: number
  readonly maxDatabaseBytes: number
  readonly maxDatabases: number
  readonly maxKeyBytes: number
  readonly maxKeysPerList: number
  readonly maxPendingOperations: number
  readonly maxRowsPerQuery: number
  readonly maxSqlBytes: number
  readonly maxSqlInstructions: number
  readonly maxTransactionStatements: number
  readonly maxValueBytes: number
}

interface StorageNamespaceV2 {
  readonly namespaceId: string
  readonly operations: readonly StorageOperationV1[]
  readonly keyPrefixes: readonly string[]
  readonly databases: readonly string[]
}

type StorageSandboxV2 =
  | Readonly<{ access: 'none' }>
  | Readonly<{
    access: 'sandboxed'
    limits: StorageLimitsV2
    namespaces: readonly StorageNamespaceV2[]
  }>

interface StorageCapabilityConstraintsV1 extends StorageNamespaceV2 {
  readonly limits: StorageLimitsV2
}

interface StorageKvResourceV1 extends CanonicalResourceBaseV1 {
  readonly kind: 'storageKv'
  readonly namespaceId: string
  readonly selector: 'key' | 'prefix'
  readonly selectorDigest: string
}

interface StorageSqlResourceV1 extends CanonicalResourceBaseV1 {
  readonly kind: 'storageSql'
  readonly namespaceId: string
  readonly database: string
}

interface StorageProviderSelectionV1 {
  readonly namespaceId: string
  readonly operation: StorageOperationV1
  readonly keyPrefixes: readonly string[]
  readonly databases: readonly string[]
  readonly limits: StorageLimitsV2
}
```

缺失 `storage` 正规化为 `{access:'none'}`；unknown、错误类型、重复 namespaceId/operation/prefix/database、孤立代理项、非 Unicode scalar 和超限均拒绝。`namespaceId` 是公开别名，默认为 `default`；物理 namespace 和目录只由 Host 分配，不进入 Policy/Guest/resource。Key/prefix 长度以 UTF-8 bytes 计，前缀匹配原始 key 或 list prefix。SQL database 是逻辑名，精确匹配。Capability normalize 保留同一 namespace；meet 交集操作/数据库、取更窄前缀及十一项数值最小值；satisfies 不允许宽化。Policy 拒绝发生在 Middleware/Provider 前。

| Member             | Operation                  | Capability   | Args                        | Result                                             | Resource             |
| ------------------ | -------------------------- | ------------ | --------------------------- | -------------------------------------------------- | -------------------- |
| kv.delete          | storage.kv.delete          | host.storage | StorageKvKeyArgsV1          | boolean or closed Storage error                    | StorageKvResourceV1  |
| kv.get             | storage.kv.get             | host.storage | StorageKvKeyArgsV1          | StorageKvGetResultV1 or closed Storage error       | StorageKvResourceV1  |
| kv.list            | storage.kv.list            | host.storage | StorageKvListArgsV1         | StorageKvListResultV1 or closed Storage error      | StorageKvResourceV1  |
| kv.set             | storage.kv.set             | host.storage | StorageKvSetArgsV1          | StorageVoidResultV1 or closed Storage error        | StorageKvResourceV1  |
| sqlite.execute     | storage.sqlite.execute     | host.storage | StorageSqlStatementArgsV1   | StorageExecuteResultV1 or closed Storage error     | StorageSqlResourceV1 |
| sqlite.query       | storage.sqlite.query       | host.storage | StorageSqlStatementArgsV1   | StorageQueryResultV1 or closed Storage error       | StorageSqlResourceV1 |
| sqlite.transaction | storage.sqlite.transaction | host.storage | StorageSqlTransactionArgsV1 | StorageTransactionResultV1 or closed Storage error | StorageSqlResourceV1 |

`createStorageInvocationV1` 将 `v1.kv.*` / `v1.sqlite.*` 映射成 `holo:storage` Promise JSON。KV set 参数仅带 `valueByteLength` 与 exact copied bytes 的 `valueSha256`；Host 以 NativePort `callToken` 私有绑定 bytes，Provider/Rust 在 I/O 前重算，不能由 Guest 指定。取消经 Kernel `signal` out-of-band，Storage args 不加入 signal marker。Provider result 的 `{error:{code}}` 只接受已有 `StorageErrorCode`；Broker 自身 policy/cancel/timeout 分别映射 `storage.authorization_denied`/`storage.cancelled`/`storage.timeout`。

KV selector digest=`canonicalDigest(['storage.selector',selector,rawText])`；semantic digest=`canonicalDigest(['storageKv',namespaceId,selector,selectorDigest])`。`selector='key'` 与 `selector='prefix'` 不碰撞，resource 不含原 key。SQL semantic digest=`canonicalDigest(['storageSql',namespaceId,database])`，不含 SQL text、callId 或 invocation identity。二者各自使用 closed resource kind，互不碰撞。对应 machine schema/vectors 从 TypeScript owner 生成。
