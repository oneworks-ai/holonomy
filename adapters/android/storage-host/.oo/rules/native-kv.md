# Native KV transport and lifecycle contract

This module implements `RuntimeNativeHost` for the four shared `host.storage`
`v1.kv.*` operations. It reuses NativeBridge v4 transport and the shared Storage
Broker registry; it does not install a facade or make policy decisions for the Broker.

The integrating Host creates one `AndroidStorageNativeHost` per generation with
`AndroidStorageHostConfiguration(rootDirectory, namespace, principal, generation,
limits, operations)`. Provision an owner-only `0700` directory below the app's
`noBackupFilesDir` and pass its `canonicalFile`. Neither constructor performs IO.
The private namespace chooses only provider-owned hashed filenames. The public
logical namespace is `default`. No native path is serialized in configuration.

The existing generation queue owns delivery of all sink events. Dispatch does
bounded validation and binary copying, then schedules one bounded worker. It never
performs disk IO in `RuntimeCapabilityHost.invokeSync` or on the runtime thread.
Root integration must include `:storage-host`, add the corresponding dependency,
and route `host.storage` calls to this generation-owned native host. Existing
Network and other NativePort routing must remain composed.

## Provider-only context

Keep NativeBridge's `{authority:{principal,capabilities},callToken,mode,resources}`.
Require `host.storage.v1`, `mode: 'result'` and no resource bindings for KV.
Only trusted Broker glue may append:

```json
{
  "storageSelection": {
    "namespaceId": "default",
    "operation": "storage.kv.set",
    "keyPrefixes": ["allowed/"],
    "databases": [],
    "limits": {
      "maxKeyBytes": 1024,
      "maxValueBytes": 1048576,
      "maxKeysPerList": 1024,
      "maxPendingOperations": 32
    }
  },
  "storageValue": {
    "byteLength": 3,
    "sha256": "<64 lowercase hexadecimal characters>"
  }
}
```

`storageSelection` is the unmodified `storageSelectionForProviderV1` selection;
its limits can include all eleven `StorageLimitsV2` fields. The native KV subset
consumes the four applicable fields above and clamps them to Host limits.
`storageValue` is required only for set and comes from the shared invocation's
`valueByteLength`/`valueSha256` commitment. It is compared with the copied bytes
before any disk work. Neither object may come from guest arguments.

Requests remain `{id,module:'host.storage',operation:'v1.kv.*',args}` (optional
Bridge-owned `deadlineMs`). Args contain only `{key}` or `{prefix}`. Set has one
binary item, `RuntimeNativeBinary("value", bytes)`; other calls have none.
Bridge owns deadlines, guest cancellation, request liveness and response quotas.

Every event has `type: 'result'`. The `value` envelope is `{ok:true,value:...}` or
`{ok:false,error:{code:'storage.*'}}`. Set success and missing get use `null`;
found get uses `true` plus one copied binary item with handle `value`; delete
uses a boolean; list uses a sorted array and fails rather than truncating.
No platform error, exception or path enters an event.

## Persistence and lifecycle

One worker serializes native operations. An OS try-lock also prevents simultaneous
providers/processes from modifying the same private namespace; contention returns
`storage.conflict`. Call-token cancellation removes queued work and fences running
work. Close clears queued work, interrupts the worker and prevents later commit or
delivery. Bridge/Javet's generation queue remains the final delivery fence.

The binary snapshot has strict entry/length/UTF-8 checks. Keys never become paths.
Defaults bound keys to 1024 bytes, values to 1 MiB, list results to 1024 entries,
pending calls to 32, the store to 4096 entries and the snapshot to 32 MiB.
The reader never enumerates directories. Writes use owner-only staging, `force`,
and atomic replacement, with no non-atomic fallback. A fixed staging filename
bounds crash leftovers to one additional snapshot per private namespace.
Cancellation before the commit lock leaves the previous snapshot intact. Once an
atomic replacement has committed, later cancellation cannot roll back that write.

This assumes an app-private directory and trusted same-UID Host code. It is not
an isolation boundary against a malicious Android process sharing that UID.
It guarantees atomic replacement and process-restart persistence; no claim of
directory-fsync durability across device power loss is made. A corrupted snapshot
fails closed with `storage.internal` and is not silently replaced.

## Explicit unsupported surface

`v1.sqlite.*` and `v1.credential.*` return `storage.not_supported`; they are absent
from the advertised installation operations. There is no SQL parser, SQL regex
filter, SharedPreferences storage or credential export.

The [Android SQLiteDatabase public API](https://developer.android.com/reference/android/database/sqlite/SQLiteDatabase)
does not expose a compile-time authorizer. This was also verified against the
installed API 35 `android.jar` with `javap`. SQLite's
[sqlite3_set_authorizer](https://sqlite.org/c3ref/set_authorizer.html) enforces
action decisions during prepare; an equivalent reviewed native binding would be
needed before admitting arbitrary SQLite statements. Platform SQLite APIs alone
therefore do not satisfy the current sandbox's ATTACH/PRAGMA/extension/trigger
requirements. Android Keystore integration is a separate follow-up.

## Verification

From `adapters/android` after the root build includes this module:

```sh
./gradlew --offline --no-daemon :storage-host:testDebugUnitTest
./gradlew --no-daemon :storage-host:assembleDebug :storage-host:lintDebug
```

Module-local JUnit covers native IO, lifecycle and authorization seams. It uses
the existing cached Gson 2.10.1 and JUnit 4.13.2 dependencies and an Android JSON
JVM substitute. Real Android JSON/Javet/Broker integration requires the shared
JavaScript emulator conformance run owned by the integrating Host task.
