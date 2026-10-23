use serde_json::json;
#[cfg(unix)]
use std::os::unix::fs::{PermissionsExt, symlink};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
fn storage_policy(
    operations: &[&str],
    key_prefixes: &[&str],
    databases: &[&str],
) -> serde_json::Value {
    json!({
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
            "operations": operations,
            "keyPrefixes": key_prefixes,
            "databases": databases
        }]
    })
}
fn all_storage_policy() -> serde_json::Value {
    storage_policy(
        &[
            "storage.kv.delete",
            "storage.kv.get",
            "storage.kv.list",
            "storage.kv.set",
            "storage.sqlite.execute",
            "storage.sqlite.query",
            "storage.sqlite.transaction",
        ],
        &[""],
        &["app", "#kv"],
    )
}
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-storage-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("data")).unwrap();
        fs::create_dir(root.join("plugins")).unwrap();
        fs::write(root.join("package.json"), r#"{"type":"module"}"#).unwrap();
        #[cfg(unix)]
        fs::set_permissions(root.join("data"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("index.js"), SCRIPT).unwrap();
        Self(root)
    }
    fn configure(&self, file: &str, namespace: &str) {
        fs::write(
            self.0.join(file),
            json!({
                "schemaVersion": 1,
                "sandboxPolicy": { "schemaVersion": 2, "storage": all_storage_policy() },
                "storage": {
                    "directory": "./data",
                    "namespace": namespace,
                    "operations": [
                        "v1.kv.get", "v1.kv.set", "v1.sqlite.execute",
                        "v1.sqlite.query", "v1.sqlite.transaction"
                    ]
                }
            })
            .to_string(),
        )
        .unwrap();
    }
    fn run(&self, config: Option<&str>, mode: &str) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_holo"));
        command.args(["--timeout", "10000"]);
        if let Some(config) = config {
            command.args(["--host-config", config]);
        }
        command
            .args(["index.js", mode])
            .env_clear()
            .env("PATH", "")
            .current_dir(&self.0)
            .output()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn output(result: Output) -> String {
    assert!(
        result.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}

const SCRIPT: &str = r#"
import storage from 'holo:storage'
const mode = process.argv[2]
if (mode === 'write') {
  await storage.kv.set('hello', new Uint8Array([1, 2, 3]))
  await storage.sqlite.execute('app', { sql: 'CREATE TABLE IF NOT EXISTS items (value TEXT)' })
  try {
    await storage.sqlite.transaction('app', [
      { sql: 'INSERT INTO items(value) VALUES (?)', params: ['rolled-back'] },
      { sql: 'INSERT INTO absent(value) VALUES (?)', params: ['bad'] }
    ])
  } catch (error) { console.log('ROLLBACK_ERROR', error.code) }
  const aborted = new AbortController()
  aborted.abort()
  try { await storage.kv.set('cancelled', new Uint8Array([9]), { signal: aborted.signal }) }
  catch (error) { console.log('CANCEL_ERROR', error.code) }
  try { await storage.sqlite.execute('app', { sql: "ATTACH DATABASE '/tmp/holo-storage-escape.sqlite3' AS escape" }) }
  catch (error) { console.log('ATTACH_ERROR', error.code) }
  try { await storage.sqlite.execute('app', { sql: "VACUUM INTO '/tmp/holo-storage-escape.sqlite3'" }) }
  catch (error) { console.log('VACUUM_ERROR', error.code) }
  console.log('WROTE')
} else if (mode === 'read') {
  console.log('VALUE', [...await storage.kv.get('hello')].join(','))
  console.log('CANCELLED', await storage.kv.get('cancelled'))
  const rows = await storage.sqlite.query('app', { sql: 'SELECT COUNT(*) AS n FROM items' })
  console.log('ROWS', rows[0].n)
  console.log('EXPOSED', Object.keys(storage).sort().join(','))
} else if (mode === 'flight') {
  const controller = new AbortController()
  const long = 'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000000) INSERT INTO items(value) SELECT CAST(n AS TEXT) FROM seq'
  const pending = storage.sqlite.transaction('app', [
    { sql: "INSERT INTO items(value) VALUES ('before-cancel')" },
    { sql: long }
  ], { signal: controller.signal })
  setTimeout(() => controller.abort(), 1)
  try { await pending } catch (error) { console.log('FLIGHT_ERROR', error.code) }
  const rows = await storage.sqlite.query('app', { sql: "SELECT COUNT(*) AS n FROM items WHERE value='before-cancel'" })
  console.log('FLIGHT_ROWS', rows[0].n)
  const firstController = new AbortController()
  const queuedController = new AbortController()
  const first = storage.sqlite.transaction('app', [{ sql: long }], { signal: firstController.signal })
  const queued = storage.kv.set('queued-cancel', new Uint8Array([7]), { signal: queuedController.signal })
  setTimeout(() => { queuedController.abort(); firstController.abort() }, 1)
  const results = await Promise.allSettled([first, queued])
  console.log('QUEUED_ERROR', results[1].reason?.code)
  console.log('QUEUED_VALUE', await storage.kv.get('queued-cancel'))
} else if (mode === 'other') {
  console.log('OTHER_VALUE', await storage.kv.get('hello'))
} else if (mode === 'family') {
  await storage.kv.set('family-secret', new Uint8Array([42]))
  try { await storage.sqlite.query('#kv', { sql: 'SELECT hex(value) AS leaked FROM kv' }) }
  catch (error) { console.log('FAMILY_ERROR', error.code) }
  try { await storage.kv.get('family-secret') }
  catch (error) { console.log('RIGHTS_ERROR', error.code) }
}
"#;

#[test]
fn path_empty_holo_persists_and_rolls_back_with_namespace_isolation() {
    let fixture = Fixture::new();
    fixture.configure("host.json", "private-a");
    fixture.configure("other.json", "private-b");
    fs::write(
        fixture.0.join("family.json"),
        json!({
            "schemaVersion": 1,
            "sandboxPolicy": { "schemaVersion": 2, "storage": all_storage_policy() },
            "storage": {
                "directory": "./data",
                "namespace": "private-a",
                "operations": ["v1.kv.set", "v1.sqlite.query"]
            }
        })
        .to_string(),
    )
    .unwrap();
    let wrote = output(fixture.run(Some("host.json"), "write"));
    for expected in [
        "ROLLBACK_ERROR storage.sqlite_failed",
        "CANCEL_ERROR storage.cancelled",
        "ATTACH_ERROR storage.sqlite_failed",
        "VACUUM_ERROR storage.sqlite_failed",
        "WROTE",
    ] {
        assert!(wrote.contains(expected), "{wrote}");
    }
    let read = output(fixture.run(Some("host.json"), "read"));
    assert!(
        read.contains("VALUE 1,2,3\nCANCELLED null\nROWS 0\n"),
        "{read}"
    );
    assert!(read.contains("EXPOSED credentials,kv,sqlite"), "{read}");
    assert!(!read.contains(fixture.0.to_str().unwrap()));
    assert!(!read.contains("private-a"));
    let flight = output(fixture.run(Some("host.json"), "flight"));
    for expected in [
        "FLIGHT_ERROR storage.cancelled",
        "FLIGHT_ROWS 0",
        "QUEUED_ERROR storage.cancelled",
        "QUEUED_VALUE null",
    ] {
        assert!(flight.contains(expected), "{flight}");
    }
    assert_eq!(
        output(fixture.run(Some("other.json"), "other")),
        "OTHER_VALUE null\n"
    );
    let family = output(fixture.run(Some("family.json"), "family"));
    assert!(
        family.contains("FAMILY_ERROR storage.not_found"),
        "{family}"
    );
    assert!(
        family.contains("RIGHTS_ERROR storage.authorization_denied"),
        "{family}"
    );
    let denied = fixture.run(None, "read");
    assert!(!denied.status.success());
    assert!(!String::from_utf8_lossy(&denied.stderr).contains(fixture.0.to_str().unwrap()));
}

#[test]
fn installed_storage_without_policy_and_host_operation_denial_have_no_io() {
    let fixture = Fixture::new();
    fixture.configure("host.json", "private-a");
    let mut config: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.0.join("host.json")).unwrap()).unwrap();
    config["sandboxPolicy"] = json!({"schemaVersion":2});
    fs::write(fixture.0.join("host.json"), config.to_string()).unwrap();
    fs::write(
        fixture.0.join("index.js"),
        "import storage from 'holo:storage'; await storage.kv.set('key',new Uint8Array([1]));",
    )
    .unwrap();
    assert!(!fixture.run(Some("host.json"), "write").status.success());
    assert_eq!(fs::read_dir(fixture.0.join("data")).unwrap().count(), 0);

    fixture.configure("host.json", "private-a");
    let mut config: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.0.join("host.json")).unwrap()).unwrap();
    config["storage"]["operations"] = json!(["v1.kv.get"]);
    fs::write(fixture.0.join("host.json"), config.to_string()).unwrap();
    fs::write(fixture.0.join("index.js"), r#"
      import assert from 'node:assert/strict'; import storage from 'holo:storage';
      await assert.rejects(storage.kv.set('key',new Uint8Array([1])),{code:'storage.authorization_denied'});
      console.log('HOST_DENIED');
    "#).unwrap();
    assert!(output(fixture.run(Some("host.json"), "write")).contains("HOST_DENIED"));
    assert_eq!(fs::read_dir(fixture.0.join("data")).unwrap().count(), 0);
}

#[test]
fn policy_key_scope_and_host_limits_deny_before_disk_access() {
    let fixture = Fixture::new();
    fixture.configure("host.json", "private-a");
    let mut config: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.0.join("host.json")).unwrap()).unwrap();
    config["sandboxPolicy"]["storage"] = storage_policy(&["storage.kv.set"], &["allowed/"], &[]);
    config["storage"]["limits"] = json!({"maxValueBytes":1});
    fs::write(fixture.0.join("host.json"), config.to_string()).unwrap();
    fs::write(fixture.0.join("index.js"), r#"
      import assert from 'node:assert/strict'; import storage from 'holo:storage';
      await assert.rejects(storage.kv.set('blocked',new Uint8Array([1])),{code:'storage.authorization_denied'});
      await assert.rejects(storage.kv.set('allowed/key',new Uint8Array([1,2])),{code:'storage.invalid_argument'});
      console.log('SCOPES_DENIED');
    "#).unwrap();
    assert!(output(fixture.run(Some("host.json"), "write")).contains("SCOPES_DENIED"));
    assert_eq!(fs::read_dir(fixture.0.join("data")).unwrap().count(), 0);

    config["sandboxPolicy"]["storage"] = storage_policy(&["storage.sqlite.execute"], &[], &["app"]);
    config["storage"]["limits"] = json!({"maxDatabaseBytes":1});
    fs::write(fixture.0.join("host.json"), config.to_string()).unwrap();
    fs::write(fixture.0.join("index.js"), r#"
      import assert from 'node:assert/strict'; import storage from 'holo:storage';
      await assert.rejects(storage.sqlite.execute('app',{sql:'CREATE TABLE t (n INTEGER)'}),{code:'storage.limit_exceeded'});
      console.log('DISK_CAP_DENIED');
    "#).unwrap();
    assert!(output(fixture.run(Some("host.json"), "write")).contains("DISK_CAP_DENIED"));
    assert_eq!(fs::read_dir(fixture.0.join("data")).unwrap().count(), 0);
}

#[test]
fn cordis_intercepts_storage_operation_before_native_io() {
    let fixture = Fixture::new();
    fixture.configure("host.json", "private-a");
    fs::write(
        fixture.0.join("plugins/deny.mjs"),
        r#"
      export default ctx => {
        ctx.holo.intercept({operation:'storage.kv.set'}, (invocation,next) => {
          if (invocation.resource.requested.kind === 'storageKv' &&
              invocation.resource.requested.namespaceId === 'default' &&
              invocation.arguments.key === 'key' &&
              invocation.hostContext.tenantId === 'private-test' &&
              Object.isFrozen(invocation.resource.requested) &&
              Object.isFrozen(invocation.arguments) &&
              !JSON.stringify(invocation.resource).includes('private-a')) return ctx.holo.deny(invocation);
          return next();
        }, {execution:'async'});
      };
    "#,
    )
    .unwrap();
    let mut config: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.0.join("host.json")).unwrap()).unwrap();
    config["plugins"] = json!([{"id":"deny-storage","use":"./plugins/deny.mjs"}]);
    config["context"] = json!({"schemaVersion":1,"guest":{"application":{"id":"guest"}},"host":{"tenantId":"private-test"}});
    fs::write(fixture.0.join("host.json"), config.to_string()).unwrap();
    fs::write(fixture.0.join("index.js"), r#"
      import assert from 'node:assert/strict'; import storage from 'holo:storage';
      await assert.rejects(storage.kv.set('key',new Uint8Array([1])),{code:'storage.authorization_denied'});
      console.log('CORDIS_DENIED');
    "#).unwrap();
    assert!(output(fixture.run(Some("host.json"), "write")).contains("CORDIS_DENIED"));
    assert_eq!(fs::read_dir(fixture.0.join("data")).unwrap().count(), 0);
}

#[test]
fn storage_deadline_cancels_delayed_middleware_without_late_io() {
    let fixture = Fixture::new();
    fixture.configure("host.json", "private-a");
    fs::write(
        fixture.0.join("plugins/delay.mjs"),
        r#"
      export default ctx => {
        ctx.holo.intercept(
          {operation:'storage.kv.set'},
          async (_invocation,next) => {
            await new Promise(resolve => setTimeout(resolve, 50));
            return next();
          },
          {execution:'async',timeoutMs:1000}
        );
      };
    "#,
    )
    .unwrap();
    let mut config: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.0.join("host.json")).unwrap()).unwrap();
    config["plugins"] = json!([{"id":"delay-storage","use":"./plugins/delay.mjs"}]);
    fs::write(fixture.0.join("host.json"), config.to_string()).unwrap();
    fs::write(fixture.0.join("index.js"), r#"
      import assert from 'node:assert/strict'; import storage from 'holo:storage';
      await assert.rejects(storage.kv.set('key',new Uint8Array([1]),{timeoutMs:1}),{code:'storage.timeout'});
      await new Promise(resolve => setTimeout(resolve, 100));
      console.log('DEADLINE_NO_IO');
    "#).unwrap();
    assert!(output(fixture.run(Some("host.json"), "write")).contains("DEADLINE_NO_IO"));
    assert_eq!(fs::read_dir(fixture.0.join("data")).unwrap().count(), 0);
}

#[test]
fn valid_timeout_remains_usable_after_native_clock_has_advanced_fractionally() {
    let fixture = Fixture::new();
    fixture.configure("host.json", "fractional-clock");
    fs::write(
        fixture.0.join("index.js"),
        r#"
        import assert from 'node:assert/strict'; import storage from 'holo:storage';
        await storage.kv.set('clock',new Uint8Array([42]));
        for(let index=0;index<5;index++) {
            await new Promise(resolve=>setTimeout(resolve,1));
            assert.deepEqual([...await storage.kv.get('clock',{timeoutMs:1000})],[42]);
        }
        console.log('FRACTIONAL_TIMEOUT_OK');
    "#,
    )
    .unwrap();
    assert!(output(fixture.run(Some("host.json"), "read")).contains("FRACTIONAL_TIMEOUT_OK"));
}

#[test]
fn policy_and_host_pending_caps_cover_storage_middleware_before_io() {
    for (policy_cap, host_cap) in [(1, 4), (4, 1)] {
        let fixture = Fixture::new();
        fixture.configure("host.json", "private-a");
        fs::write(
            fixture.0.join("plugins/delay.mjs"),
            r#"
          export default ctx => {
            let active = false;
            ctx.holo.intercept({operation:'storage.kv.get'}, async (_invocation,next) => {
              if (active) throw new Error('CONCURRENT_STORAGE_MIDDLEWARE');
              active = true;
              try {
                await new Promise(resolve => setTimeout(resolve, 75));
                return await next();
              } finally { active = false; }
            }, {execution:'async',timeoutMs:1000});
          };
        "#,
        )
        .unwrap();
        let mut config: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture.0.join("host.json")).unwrap()).unwrap();
        config["sandboxPolicy"]["storage"]["limits"]["maxPendingOperations"] = json!(policy_cap);
        config["storage"]["limits"] = json!({"maxPendingOperations":host_cap});
        config["plugins"] = json!([{"id":"delay-storage","use":"./plugins/delay.mjs"}]);
        fs::write(fixture.0.join("host.json"), config.to_string()).unwrap();
        fs::write(
            fixture.0.join("index.js"),
            r#"
          import assert from 'node:assert/strict'; import storage from 'holo:storage';
          const first = storage.kv.get('first');
          const second = storage.kv.get('second');
          const both = await Promise.allSettled([first, second]);
          assert.equal(both.filter(item => item.status === 'fulfilled' && item.value === null).length, 1);
          assert.equal(both.filter(item => item.status === 'rejected' && item.reason.code === 'storage.limit_exceeded').length, 1);
          await new Promise(resolve => setTimeout(resolve, 20));
          assert.equal(await storage.kv.get('after-settle'), null);
          console.log('PENDING_CAP_OK');
        "#,
        )
        .unwrap();
        assert!(output(fixture.run(Some("host.json"), "quota")).contains("PENDING_CAP_OK"));
        assert_eq!(fs::read_dir(fixture.0.join("data")).unwrap().count(), 0);
    }
}

#[cfg(unix)]
#[test]
fn host_storage_installation_rejects_unknown_fields_and_untrusted_directories() {
    let fixture = Fixture::new();
    fixture.configure("host.json", "private-a");
    let mut invalid: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.0.join("host.json")).unwrap()).unwrap();
    invalid["storage"]["guestPath"] = json!("/tmp/escape");
    fs::write(fixture.0.join("host.json"), invalid.to_string()).unwrap();
    assert!(!fixture.run(Some("host.json"), "write").status.success());
    fixture.configure("host.json", "private-a");
    fs::set_permissions(fixture.0.join("data"), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!fixture.run(Some("host.json"), "write").status.success());
    fs::remove_dir(fixture.0.join("data")).unwrap();
    fs::create_dir(fixture.0.join("real")).unwrap();
    fs::set_permissions(fixture.0.join("real"), fs::Permissions::from_mode(0o700)).unwrap();
    symlink(fixture.0.join("real"), fixture.0.join("data")).unwrap();
    assert!(!fixture.run(Some("host.json"), "write").status.success());
    fs::remove_file(fixture.0.join("data")).unwrap();
    fs::create_dir(fixture.0.join("unsafe-parent")).unwrap();
    fs::set_permissions(
        fixture.0.join("unsafe-parent"),
        fs::Permissions::from_mode(0o777),
    )
    .unwrap();
    fs::create_dir(fixture.0.join("unsafe-parent/data")).unwrap();
    fs::set_permissions(
        fixture.0.join("unsafe-parent/data"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let mut unsafe_config: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.0.join("host.json")).unwrap()).unwrap();
    unsafe_config["storage"]["directory"] = json!("./unsafe-parent/data");
    fs::write(fixture.0.join("host.json"), unsafe_config.to_string()).unwrap();
    assert!(!fixture.run(Some("host.json"), "write").status.success());
}

#[test]
fn readonly_storage_operations_never_create_database_files_or_consume_quota() {
    let fixture = Fixture::new();
    let mut policy = all_storage_policy();
    policy["namespaces"][0]["databases"] = json!(
        (0..20)
            .map(|index| format!("missing-{index}"))
            .collect::<Vec<_>>()
    );
    fs::write(fixture.0.join("read.json"), json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2,"storage":policy},
        "storage":{"directory":"./data","namespace":"read-only","operations":["v1.kv.get","v1.kv.list","v1.kv.delete","v1.sqlite.query"]}}).to_string()).unwrap();
    fs::write(fixture.0.join("index.js"), r#"
        import assert from 'node:assert/strict'; import storage from 'holo:storage';
        assert.equal(await storage.kv.get('missing'),null);
        assert.deepEqual(await storage.kv.list(),[]);
        assert.equal(await storage.kv.delete('missing'),false);
        await assert.rejects(storage.sqlite.query('not-admitted',{sql:'SELECT 1 AS value'}),{code:'storage.authorization_denied'});
        for(let index=0;index<20;index++) {
            await assert.rejects(storage.sqlite.query('missing-'+index,{sql:'SELECT 1 AS value'}),{code:'storage.not_found'});
        }
        console.log('READ_ONLY_NO_CREATION');
    "#).unwrap();
    assert!(output(fixture.run(Some("read.json"), "read")).contains("READ_ONLY_NO_CREATION"));
    assert_eq!(fs::read_dir(fixture.0.join("data")).unwrap().count(), 0);
}

#[test]
fn throwing_or_shadowed_abort_listeners_cannot_commit_a_cancelled_transaction() {
    for throwing in [true, false] {
        let fixture = Fixture::new();
        fixture.configure("host.json", "abort-proof");
        output(fixture.run(Some("host.json"), "write"));
        let setup = if throwing {
            "controller.signal.onabort=()=>{throw new Error('USER_ONABORT_ERROR')}; controller.signal.addEventListener('abort',()=>{throw new Error('USER_LISTENER_ERROR')});"
        } else {
            "assert.equal(controller.signal.listeners,undefined); controller.signal.listeners={clear(){}}; controller.signal.listeners.clear();"
        };
        fs::write(fixture.0.join("index.js"), format!(r#"
            import assert from 'node:assert/strict'; import storage from 'holo:storage';
            const controller=new AbortController(); {setup}
            const pending=storage.sqlite.transaction('app',[
                {{sql:"INSERT INTO items(value) VALUES ('must-rollback')"}},
                {{sql:'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000000) INSERT INTO items(value) SELECT CAST(n AS TEXT) FROM seq'}}
            ],{{signal:controller.signal}});
            void pending.catch(()=>{{}});
            setTimeout(()=>controller.abort(),1);
            await assert.rejects(pending,{{code:'storage.cancelled'}});
            console.log('PRIVATE_LISTENERS_CANCELLED');
        "#)).unwrap();
        let result = fixture.run(Some("host.json"), "abort");
        if throwing {
            assert!(
                !result.status.success(),
                "listener errors must reach Runtime error reporting"
            );
        } else {
            assert!(output(result).contains("PRIVATE_LISTENERS_CANCELLED"));
        }
        fs::write(fixture.0.join("index.js"), SCRIPT).unwrap();
        assert!(output(fixture.run(Some("host.json"), "read")).contains("ROWS 0"));
    }
}
