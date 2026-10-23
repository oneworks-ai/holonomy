# Native desktop Storage

[简体中文](storage.zh-Hans.md)

Native `holo:storage` keeps the shared StorageFacade and NativeBridge v4. Every KV and SQLite request enters the existing SandboxPolicyV2 → Capability Broker → Cordis interceptor → `host.storage` Provider path before Rust starts I/O. An installation alone grants nothing: omitted `sandboxPolicy.storage` means `access: none`.

Create a Host-only directory with `0700` permissions on Unix, separate from Guest source and FS grants. Select the logical `default` namespace in Policy and map it to the physical namespace in `--host-config`:

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

Policy names only logical namespaces, operations, KV key prefixes, SQL database names and limits. The Host installation chooses the actual namespace and directory; neither enters Guest values, Inspector output or plugin resource identities. Its optional `storage.limits` object can lower any of the eleven Policy limit fields. The effective cap is the smaller Policy/Host value. The Host operation list also remains an allowlist. Unknown fields or operations fail validation.

```js
import storage from 'holo:storage'
await storage.kv.set('key', new Uint8Array([1, 2, 3]))
console.log(await storage.kv.get('key'))
await storage.sqlite.execute('app', {
  sql: 'CREATE TABLE IF NOT EXISTS items (name TEXT)'
})
```

Binary KV persists across processes. One Host worker executes SQLite calls FIFO, with exclusive transactions and rollback on failure or cancellation before commit. Provider and Rust both check the selected operation, logical namespace, key/database scope and call limits; a KV write also checks the copied value's length and SHA-256 before I/O. The SQLite authorizer and defensive settings deny PRAGMA, ATTACH/DETACH, extensions, temp schema, virtual tables, triggers and Guest transaction control.

Reads do not create database files or schema. Missing KV returns `null` for get, `[]` for list and `false` for delete; SQL query on a missing logical database rejects with `storage.not_found`. Query uses a read-only connection. Runtime close cancels outstanding calls and joins the worker. A cancelled or late Native completion is discarded by its original call token.

Result ceilings apply after both Provider execution and a Host short circuit. For SQL rows, `maxValueBytes` also bounds aggregate column-name UTF-8 plus JSON-encoded scalar bytes, matching the native transport's logical data budget; many individually small cells cannot bypass it. The legacy facade also uses `maxKeyBytes`/`maxKeysPerList` to bound column names/count, with an additional native 128-column ceiling.

Credential handles remain unsupported: no Keychain or secret-material Provider is installed. The directory and existing files must be owner-controlled, regular and free of symlink aliases. This does not install a descriptor-pinned SQLite VFS against a malicious same-owner process racing path replacement.

Focused verification: `cargo test -p holonomy-cli --test storage --locked` runs the real executable with an empty `PATH` and separate processes.
