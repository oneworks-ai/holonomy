# 原生桌面 Storage

[English](storage.md)

原生 `holo:storage` 继续使用共享 StorageFacade 与 NativeBridge v4。每次 KV／SQLite 调用先进入既有 SandboxPolicyV2 → Capability Broker → Cordis 拦截 → `host.storage` Provider，再由 Rust 执行 I/O。单独安装物理目录不授予权限；省略 `sandboxPolicy.storage` 等同于 `access: none`。

先创建与 Guest 源码及 FS 授权分离的 Host 私有目录（Unix 权限 `0700`）。Policy 选择公开的 `default` 逻辑 namespace，`--host-config` 将它映射到实际 namespace：

```json
{
  "schemaVersion": 1,
  "sandboxPolicy": {
    "schemaVersion": 2,
    "storage": {
      "access": "sandboxed",
      "limits": {
        "maxDatabaseNameBytes": 128,
        "maxDatabaseBytes": 33554432,
        "maxDatabases": 16,
        "maxKeyBytes": 1024,
        "maxKeysPerList": 1024,
        "maxPendingOperations": 128,
        "maxRowsPerQuery": 1024,
        "maxSqlBytes": 65536,
        "maxSqlInstructions": 10000000,
        "maxTransactionStatements": 256,
        "maxValueBytes": 1048576
      },
      "namespaces": [{
        "namespaceId": "default",
        "operations": [
          "storage.kv.get",
          "storage.kv.set",
          "storage.kv.list",
          "storage.kv.delete",
          "storage.sqlite.execute",
          "storage.sqlite.query",
          "storage.sqlite.transaction"
        ],
        "keyPrefixes": [""],
        "databases": ["app"]
      }]
    }
  },
  "storage": {
    "directory": "./private-storage",
    "namespace": "my-app",
    "operations": [
      "v1.kv.get",
      "v1.kv.set",
      "v1.kv.list",
      "v1.kv.delete",
      "v1.sqlite.execute",
      "v1.sqlite.query",
      "v1.sqlite.transaction"
    ]
  }
}
```

Policy 只包含逻辑 namespace、操作、KV key 前缀、SQL 数据库名和额度。实际 namespace 与目录仅由 Host 安装指定，不进入 Guest 值、Inspector 输出或插件资源身份。可选的 `storage.limits` 能下调上述十一项额度；最终取 Policy 与 Host 的较小值。Host 操作列表也继续构成 allowlist。未知字段或操作会被拒绝。

```js
import storage from 'holo:storage'
await storage.kv.set('key', new Uint8Array([1, 2, 3]))
console.log(await storage.kv.get('key'))
await storage.sqlite.execute('app', {
  sql: 'CREATE TABLE IF NOT EXISTS items (name TEXT)'
})
```

二进制 KV 可跨进程持久化。一个 Host 工作线程按 FIFO 执行 SQLite，事务独占；失败或提交前取消会回滚。Provider 与 Rust 都在 I/O 前复核所选操作、逻辑 namespace、key／数据库范围及调用额度；KV 写入还复核复制值的长度与 SHA-256。SQLite authorizer 与防御配置拒绝 PRAGMA、ATTACH/DETACH、扩展、临时 schema、虚拟表、触发器和 Guest 事务控制。

读取不会创建数据库文件或 schema。KV 缺失时，get 返回 `null`、list 返回 `[]`、delete 返回 `false`；query 访问不存在的逻辑数据库时以 `storage.not_found` 拒绝。Query 使用只读连接。Runtime 关闭时取消在途调用并回收工作线程；取消或晚到的 Native 结果按原始 call token 丢弃。

结果上限同时覆盖 Provider 与 Host 短路。SQL 的 `maxValueBytes` 还限制所有列名 UTF-8 与 JSON 标量编码字节的总和，与 Native 逻辑数据预算一致；许多单独较小的 cell 不能绕过总额。既有 Facade 也以 `maxKeyBytes`/`maxKeysPerList` 限制列名与列数，另有 Native 的 128 列上限。

凭据 handle 仍不支持：目前没有 Keychain 或秘密材料 Provider。目录和既有文件须由 owner 控制，为普通文件且没有 symlink 别名；这里没有安装可抵御同 owner 恶意进程并发替换路径的 descriptor-pinned SQLite VFS。

聚焦验证：`cargo test -p holonomy-cli --test storage --locked` 以空 `PATH`、独立进程运行真实二进制。
