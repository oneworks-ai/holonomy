use serde_json::json;
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    process::{Command, Output},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "holo-abort-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn run(&self, source: &str, policy: Option<serde_json::Value>) -> Output {
        fs::write(self.0.join("entry.mjs"), source).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_holo"));
        command.args(["--timeout", "4000"]);
        if let Some(policy) = policy {
            fs::write(self.0.join("host.json"), policy.to_string()).unwrap();
            command.args(["--host-config", "host.json"]);
        }
        command
            .arg("entry.mjs")
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

fn success(output: Output, expected: &str) {
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains(expected),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn only_unref_abort_timeout_allows_natural_exit_and_any_preserves_reason() {
    let fixture = Fixture::new();
    let started = Instant::now();
    success(
        fixture.run(
            "AbortSignal.timeout(60000); console.log('UNREF_EXIT')",
            None,
        ),
        "UNREF_EXIT",
    );
    assert!(started.elapsed() < Duration::from_secs(3));

    success(
        fixture.run(
            r#"
                import assert from 'node:assert/strict'
                AbortSignal.prototype.dispatchAbort = () => { throw new Error('public abort shadow') }
                assert.equal(AbortSignal.abort('static').reason, 'static')
                const first = new AbortController()
                first.abort('first')
                assert.equal(AbortSignal.any([first.signal, AbortSignal.timeout(1000)]).reason, 'first')
                const source = new AbortController()
                const sourceSignal = source.signal
                sourceSignal.addEventListener = () => { throw new Error('public add shadow') }
                sourceSignal.removeEventListener = () => { throw new Error('public remove shadow') }
                const dependent = AbortSignal.any([sourceSignal])
                sourceSignal.dispatchEvent({type: 'abort'})
                assert.equal(dependent.aborted, false)
                sourceSignal.dispatchEvent = () => { throw new Error('public dispatch shadow') }
                Object.defineProperty(source, 'signal', {value: null})
                source.abort('actual')
                assert.equal(dependent.reason, 'actual')
                const later = new AbortController()
                const timeout = AbortSignal.timeout(5)
                timeout.dispatchAbort = () => { throw new Error('timeout abort shadow') }
                timeout.dispatchEvent = () => { throw new Error('timeout dispatch shadow') }
                const combined = AbortSignal.any([later.signal, timeout])
                combined.dispatchAbort = () => { throw new Error('any abort shadow') }
                const hold = setTimeout(() => {}, 100)
                await new Promise(resolve => combined.addEventListener('abort', resolve))
                clearTimeout(hold)
                assert.equal(combined.reason.name, 'TimeoutError')
                assert.throws(() => AbortSignal.any([{}]), TypeError)
                assert.throws(() => AbortSignal.any([new Proxy(later.signal, {})]), TypeError)
                console.log('ANY_TIMEOUT_REASON')
            "#,
            None,
        ),
        "ANY_TIMEOUT_REASON",
    );
}

#[test]
fn timeout_cancels_storage_transaction_without_committing_its_write() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("data")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(fixture.0.join("data"), fs::Permissions::from_mode(0o700)).unwrap();
    }
    let policy = json!({
        "schemaVersion": 1,
        "sandboxPolicy": { "schemaVersion": 2, "storage": {
            "access": "sandboxed",
            "limits": {
                "maxDatabaseNameBytes": 128, "maxDatabaseBytes": 33554432, "maxDatabases": 16,
                "maxKeyBytes": 1024, "maxKeysPerList": 1024, "maxPendingOperations": 128,
                "maxRowsPerQuery": 1024, "maxSqlBytes": 65536, "maxSqlInstructions": 10000000,
                "maxTransactionStatements": 256, "maxValueBytes": 1048576
            },
            "namespaces": [{ "namespaceId": "default", "keyPrefixes": [], "databases": ["app"],
                "operations": ["storage.sqlite.execute", "storage.sqlite.query", "storage.sqlite.transaction"] }]
        } },
        "storage": {
            "directory": "./data",
            "namespace": "abort-timeout",
            "operations": ["v1.sqlite.execute", "v1.sqlite.query", "v1.sqlite.transaction"]
        }
    });
    success(
        fixture.run(
            r#"
                import assert from 'node:assert/strict'
                import storage from 'holo:storage'
                await storage.sqlite.execute('app', {sql: 'CREATE TABLE IF NOT EXISTS items(value TEXT)'})
                const long = 'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000000) INSERT INTO items(value) SELECT CAST(n AS TEXT) FROM seq'
                const signal = AbortSignal.timeout(0)
                const pending = storage.sqlite.transaction('app', [
                    {sql: "INSERT INTO items(value) VALUES ('must-rollback')"},
                    {sql: long}
                ], {signal})
                await assert.rejects(pending, {code: 'storage.cancelled'})
                assert.equal(signal.reason.name, 'TimeoutError')
                const rows = await storage.sqlite.query('app', {sql: "SELECT COUNT(*) AS n FROM items WHERE value='must-rollback'"})
                assert.equal(rows[0].n, 0)
                console.log('STORAGE_TIMEOUT_NO_COMMIT')
            "#,
            Some(policy),
        ),
        "STORAGE_TIMEOUT_NO_COMMIT",
    );
}

struct SlowServer {
    origin: String,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl SlowServer {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let thread = thread::spawn(move || {
            while !worker_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(1)))
                            .unwrap();
                        let mut request = [0u8; 4096];
                        let _ = stream.read(&mut request);
                        thread::sleep(Duration::from_millis(250));
                        let _ = stream.write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nlate"
                        );
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            origin,
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for SlowServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}

#[test]
fn timeout_cancels_a_native_fetch() {
    let server = SlowServer::new();
    let fixture = Fixture::new();
    let policy = json!({
        "schemaVersion": 1,
        "sandboxPolicy": {
            "schemaVersion": 2,
            "network": {
                "access": "restricted",
                "allowedOrigins": [server.origin],
                "allowedSchemes": ["http"],
                "allowPrivateNetwork": true,
                "limits": {
                    "maxChunkBytes": 1024,
                    "maxConcurrentConnections": 4,
                    "maxHeaderBytes": 4096,
                    "maxHeaders": 32,
                    "maxRedirects": 5,
                    "maxRequestBodyBytes": 4096,
                    "maxResponseBodyBytes": 4096,
                    "maxUrlBytes": 4096,
                    "socketTimeoutMs": 2000
                },
                "requestBodyInspection": { "access": "none" }
            }
        }
    });
    success(
        fixture.run(
            &format!(
                r#"
                    import assert from 'node:assert/strict'
                    const signal = AbortSignal.timeout(10)
                    await assert.rejects(fetch('{}/slow', {{signal}}), {{code: 'network.cancelled'}})
                    assert.equal(signal.reason.name, 'TimeoutError')
                    console.log('FETCH_TIMEOUT_CANCELLED')
                "#,
                server.origin
            ),
            Some(policy),
        ),
        "FETCH_TIMEOUT_CANCELLED",
    );
}
