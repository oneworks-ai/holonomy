use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Command, Output},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Server {
    origin: String,
    hits: Arc<AtomicUsize>,
    slow: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    paused_headers: Arc<AtomicBool>,
    paused_disconnected: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let slow = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::new(AtomicBool::new(false));
        let body_released = Arc::new(AtomicBool::new(false));
        let paused_headers = Arc::new(AtomicBool::new(false));
        let paused_disconnected = Arc::new(AtomicBool::new(false));
        let worker_slow = slow.clone();
        let worker_cancelled = cancelled.clone();
        let worker_body_released = body_released.clone();
        let worker_paused_headers = paused_headers.clone();
        let worker_paused_disconnected = paused_disconnected.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_hits = hits.clone();
        let worker_stop = stop.clone();
        let thread = thread::spawn(move || {
            let mut workers = Vec::new();
            while !worker_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let hits = worker_hits.clone();
                        let slow = worker_slow.clone();
                        let cancelled = worker_cancelled.clone();
                        let body_released = worker_body_released.clone();
                        let paused_headers = worker_paused_headers.clone();
                        let paused_disconnected = worker_paused_disconnected.clone();
                        workers.push(thread::spawn(move || {
                            serve(
                                stream,
                                hits,
                                slow,
                                cancelled,
                                body_released,
                                paused_headers,
                                paused_disconnected,
                            )
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => break,
                }
            }
            for worker in workers {
                let _ = worker.join();
            }
        });
        Self {
            origin,
            hits,
            slow,
            cancelled,
            paused_headers,
            paused_disconnected,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
fn serve(
    mut stream: TcpStream,
    hits: Arc<AtomicUsize>,
    slow: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    body_released: Arc<AtomicBool>,
    paused_headers: Arc<AtomicBool>,
    paused_disconnected: Arc<AtomicBool>,
) {
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0; 1024];
    let split = loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(n) => bytes.extend_from_slice(&buffer[..n]),
        }
        if let Some(i) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            break i + 4;
        }
        if bytes.len() > 65536 {
            return;
        }
    };
    let header = String::from_utf8_lossy(&bytes[..split]).to_string();
    let length = header
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|v| v.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    while bytes.len() < split + length {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(n) => bytes.extend_from_slice(&buffer[..n]),
        }
    }
    hits.fetch_add(1, Ordering::Relaxed);
    let path = header
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    if path.starts_with("/paused-body") {
        let head = b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n";
        if stream.write_all(head).is_err() {
            return;
        }
        paused_headers.store(true, Ordering::Release);
        stream
            .set_read_timeout(Some(Duration::from_millis(10)))
            .unwrap();
        while !body_released.load(Ordering::Acquire) {
            let mut probe = [0_u8; 1];
            match stream.read(&mut probe) {
                Ok(0) => {
                    paused_disconnected.store(true, Ordering::Release);
                    return;
                }
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => {
                    paused_disconnected.store(true, Ordering::Release);
                    return;
                }
            }
        }
        if stream.write_all(b"stream-body").is_err() {
            paused_disconnected.store(true, Ordering::Release);
        }
        return;
    }
    if path.starts_with("/mid-timeout") {
        let _ = stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nhalf");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut probe = [0_u8; 1];
        let _ = stream.read(&mut probe);
        return;
    }
    if path.starts_with("/truncated") {
        let _ = stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nhalf");
        return;
    }
    if path.starts_with("/stream-large") {
        let first = "x".repeat(768);
        let second = "y".repeat(768);
        let response = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n300\r\n{first}\r\n300\r\n{second}\r\n0\r\n\r\n"
        );
        let _ = stream.write_all(response.as_bytes());
        return;
    }
    let (status, headers, body) = if path.starts_with("/status") {
        (200,"",json!({"slow":slow.load(Ordering::Acquire),"cancelled":cancelled.load(Ordering::Acquire),"pausedHeaders":paused_headers.load(Ordering::Acquire),"pausedDisconnected":paused_disconnected.load(Ordering::Acquire)}).to_string())
    } else if path.starts_with("/release-body") {
        body_released.store(true, Ordering::Release);
        (200, "", "released".into())
    } else if path.starts_with("/redirect-outside") {
        (
            302,
            "Location: http://denied.invalid/profile\r\n",
            String::new(),
        )
    } else if path.starts_with("/redirect") {
        (302, "Location: /profile\r\n", String::new())
    } else if path.starts_with("/echo") {
        (
            200,
            "",
            String::from_utf8_lossy(&bytes[split..split + length]).into_owned(),
        )
    } else if path.starts_with("/slow") {
        slow.store(true, Ordering::Release);
        stream
            .set_read_timeout(Some(Duration::from_millis(300)))
            .unwrap();
        let mut byte = [0];
        if matches!(stream.read(&mut byte), Ok(0)) {
            cancelled.store(true, Ordering::Release);
            return;
        }
        (200, "", "late".into())
    } else if path.starts_with("/large") {
        (200, "", "x".repeat(8192))
    } else if path.starts_with("/headers") {
        (
            200,
            "X-Over-Limit: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r\n",
            "ok".into(),
        )
    } else {
        (
            200,
            "Content-Type: application/json\r\n",
            "{\"runtime\":\"holonomy\"}".into(),
        )
    };
    let response = format!(
        "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "holo-network-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        Self(directory)
    }
    fn policy(origin: &str, private: bool) -> Value {
        json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2,"network":{"access":"restricted","allowedOrigins":[origin],"allowedSchemes":["http"],"allowPrivateNetwork":private,"limits":{"maxChunkBytes":1024,"maxConcurrentConnections":4,"maxHeaderBytes":4096,"maxHeaders":32,"maxRedirects":5,"maxRequestBodyBytes":4096,"maxResponseBodyBytes":4096,"maxUrlBytes":4096,"socketTimeoutMs":2000},"requestBodyInspection":{"access":"none"}}}})
    }
    fn run(&self, policy: &Value, source: &str) -> Output {
        fs::write(self.0.join("host.json"), policy.to_string()).unwrap();
        fs::write(self.0.join("entry.mjs"), source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args([
                "--timeout",
                "5000",
                "--host-config",
                "host.json",
                "entry.mjs",
            ])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
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
fn success(output: &Output) {
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_fetch_get_post_redirect_and_clone() {
    let server = Server::new();
    let fixture = Fixture::new();
    let origin = &server.origin;
    let output=fixture.run(&Fixture::policy(origin,true),&format!(r#"
        import assert from 'node:assert/strict';
        const response=await fetch('{origin}/profile');const clone=response.clone();
        assert.equal(response.status,200);assert.deepEqual(await response.json(),{{runtime:'holonomy'}});assert.equal(await clone.text(),'{{"runtime":"holonomy"}}');
        const posted=await fetch('{origin}/echo',{{method:'POST',body:'posted-body'}});assert.equal(await posted.text(),'posted-body');
        const redirected=await fetch('{origin}/redirect');assert.equal(redirected.redirected,true);assert.deepEqual(await redirected.json(),{{runtime:'holonomy'}});console.log('FETCH_OK');
    "#));
    success(&output);
    assert_eq!(server.hits.load(Ordering::Relaxed), 4);
}

#[test]
fn native_fetch_runs_shared_public_conformance_without_node() {
    let server = Server::new();
    let fixture = Fixture::new();
    let mut policy = Fixture::policy(&server.origin, true);
    policy["sandboxPolicy"]["systemInformation"] = json!({
        "defaultMode":"unavailable",
        "fields":{"process.env":{"allowedModes":["synthetic"],"maxPrecision":"exact"}}
    });
    policy["systemProjection"] = json!({
        "schemaVersion":1,
        "fields":{"process.env":{"mode":"synthetic","precision":"exact", "value":{"HOLONOMY_FIXTURE_URL":server.origin}}}
    });
    fs::write(fixture.0.join("host.json"), policy.to_string()).unwrap();
    fs::write(
        fixture.0.join("fetch.test.mjs"),
        include_str!("../../../conformance/specs/fetch.test.mjs"),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_holo"))
        .args([
            "test",
            "--timeout",
            "5000",
            "--host-config",
            "host.json",
            "fetch.test.mjs",
        ])
        .env_clear()
        .env("PATH", "")
        .current_dir(&fixture.0)
        .output()
        .unwrap();
    success(&output);
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["passed"], 3);
    assert_eq!(report["failed"], 0);
    assert_eq!(report["platform"], "desktop");
}

#[test]
fn native_fetch_resolves_at_headers_and_idle_credit_wait_does_not_timeout() {
    let server = Server::new();
    let fixture = Fixture::new();
    let mut policy = Fixture::policy(&server.origin, true);
    policy["sandboxPolicy"]["network"]["limits"]["socketTimeoutMs"] = json!(40);
    policy["sandboxPolicy"]["network"]["limits"]["maxChunkBytes"] = json!(3);
    let output = fixture.run(
        &policy,
        &format!(
            r#"
        import assert from 'node:assert/strict';
        const response=await fetch('{0}/paused-body');
        assert.equal(response.status,200);
        await new Promise(resolve=>setTimeout(resolve,100));
        const state=await(await fetch('{0}/status')).json();
        assert.equal(state.pausedHeaders,true);
        assert.equal(state.pausedDisconnected,false);
        assert.equal(await(await fetch('{0}/release-body')).text(),'released');
        assert.equal(await response.text(),'stream-body');
        console.log('HEADERS_BEFORE_BODY');
    "#,
            server.origin
        ),
    );
    success(&output);
    assert!(server.paused_headers.load(Ordering::Acquire));
    assert!(!server.paused_disconnected.load(Ordering::Acquire));
}

#[test]
fn native_fetch_clone_keeps_one_upstream_when_one_reader_cancels() {
    let server = Server::new();
    let fixture = Fixture::new();
    let output = fixture.run(
        &Fixture::policy(&server.origin, true),
        &format!(
            r#"
        import assert from 'node:assert/strict';
        const response=await fetch('{0}/paused-body');
        const clone=response.clone();
        await response.body.getReader().cancel('first reader done');
        assert.equal(await(await fetch('{0}/release-body')).text(),'released');
        assert.equal(await clone.text(),'stream-body');
        console.log('ONE_UPSTREAM_CLONE');
    "#,
            server.origin
        ),
    );
    success(&output);
    assert_eq!(server.hits.load(Ordering::Relaxed), 2);
    assert!(!server.paused_disconnected.load(Ordering::Acquire));
}

#[test]
fn native_fetch_final_reader_cancel_releases_connection_capacity() {
    let server = Server::new();
    let fixture = Fixture::new();
    let mut policy = Fixture::policy(&server.origin, true);
    policy["sandboxPolicy"]["network"]["limits"]["maxConcurrentConnections"] = json!(1);
    let output = fixture.run(
        &policy,
        &format!(
            r#"
        import assert from 'node:assert/strict';
        const response=await fetch('{0}/paused-body');
        await response.body.getReader().cancel('last reader done');
        let state;
        for(let attempt=0;attempt<32;attempt++){{
          state=await(await fetch('{0}/status')).json();
          if(state.pausedDisconnected)break;
          await new Promise(resolve=>setTimeout(resolve,5));
        }}
        assert.equal(state.pausedDisconnected,true);
        assert.deepEqual(await(await fetch('{0}/profile')).json(),{{runtime:'holonomy'}});
        console.log('FINAL_CANCEL_RELEASED');
    "#,
            server.origin
        ),
    );
    success(&output);
    assert!(server.paused_disconnected.load(Ordering::Acquire));
}

#[test]
fn native_fetch_streams_middle_body_timeout_oversize_and_protocol_errors() {
    let server = Server::new();
    let fixture = Fixture::new();
    let mut policy = Fixture::policy(&server.origin, true);
    policy["sandboxPolicy"]["network"]["limits"]["socketTimeoutMs"] = json!(40);
    policy["sandboxPolicy"]["network"]["limits"]["maxResponseBodyBytes"] = json!(1024);
    let output = fixture.run(
        &policy,
        &format!(
            r#"
        import assert from 'node:assert/strict';
        const timed=await fetch('{0}/mid-timeout');
        const reader=timed.body.getReader();
        const first=await reader.read();
        assert.equal(new TextDecoder().decode(first.value),'half');
        await assert.rejects(reader.read(),{{code:'network.timeout'}});
        const oversized=await fetch('{0}/stream-large');
        await assert.rejects(oversized.text(),{{code:'network.response_too_large'}});
        const truncated=await fetch('{0}/truncated');
        await assert.rejects(truncated.text(),{{code:'network.protocol_error'}});
        console.log('MIDDLE_BODY_FAILURES');
    "#,
            server.origin
        ),
    );
    success(&output);
}

#[test]
fn native_fetch_denies_private_and_ungranted_origins_before_http() {
    let server = Server::new();
    let fixture = Fixture::new();
    let origin = &server.origin;
    let output=fixture.run(&Fixture::policy(origin,false),&format!(r#"
        import assert from 'node:assert/strict';await assert.rejects(fetch('{origin}/profile'),{{code:'network.invalid_url'}});console.log('PRIVATE_DENIED');
    "#));
    success(&output);
    assert_eq!(server.hits.load(Ordering::Relaxed), 0);
    let output=fixture.run(&Fixture::policy(origin,true),r#"import assert from 'node:assert/strict';await assert.rejects(fetch('http://denied.invalid/profile'),{code:'network.invalid_url'});"#);
    success(&output);
    assert_eq!(server.hits.load(Ordering::Relaxed), 0);
}

#[test]
fn native_fetch_redirect_reauthorizes_the_destination() {
    let server = Server::new();
    let fixture = Fixture::new();
    let origin = &server.origin;
    let output=fixture.run(&Fixture::policy(origin,true),&format!(r#"
        import assert from 'node:assert/strict';await assert.rejects(fetch('{origin}/redirect-outside'),{{code:'network.invalid_url'}});
    "#));
    success(&output);
    assert_eq!(server.hits.load(Ordering::Relaxed), 1);
}

#[test]
fn native_fetch_allows_zero_redirects_for_direct_requests_and_rejects_redirects() {
    let server = Server::new();
    let fixture = Fixture::new();
    let mut policy = Fixture::policy(&server.origin, true);
    policy["sandboxPolicy"]["network"]["limits"]["maxRedirects"] = json!(0);
    let output = fixture.run(
        &policy,
        &format!(
            r#"
        import assert from 'node:assert/strict';
        assert.deepEqual(await (await fetch('{}/profile')).json(),{{runtime:'holonomy'}});
        await assert.rejects(fetch('{}/redirect'),{{code:'network.redirect_limit'}});
        console.log('ZERO_REDIRECT_LIMIT');
    "#,
            server.origin, server.origin
        ),
    );
    success(&output);
    assert_eq!(server.hits.load(Ordering::Relaxed), 2);
}

#[test]
fn native_fetch_abort_closes_the_socket_and_capacity_is_reusable() {
    let server = Server::new();
    let fixture = Fixture::new();
    let origin = &server.origin;
    let output=fixture.run(&Fixture::policy(origin,true),&format!(r#"
        import assert from 'node:assert/strict';const controller=new AbortController();
        const pending=fetch('{origin}/slow',{{signal:controller.signal}}).catch(error=>error);
        for(let attempt=0;;attempt++){{const state=await(await fetch('{origin}/status')).json();if(state.slow)break;assert.ok(attempt<32)}}
        controller.abort();assert.equal((await pending).code,'network.cancelled');
        for(let attempt=0;;attempt++){{const state=await(await fetch('{origin}/status')).json();if(state.cancelled)break;assert.ok(attempt<32)}}
        assert.deepEqual(await(await fetch('{origin}/profile')).json(),{{runtime:'holonomy'}});console.log('ABORTED_SOCKET');
    "#));
    success(&output);
    assert!(server.slow.load(Ordering::Acquire));
    assert!(server.cancelled.load(Ordering::Acquire));
}

#[test]
fn native_fetch_applies_host_socket_timeout() {
    let server = Server::new();
    let fixture = Fixture::new();
    let mut policy = Fixture::policy(&server.origin, true);
    policy["sandboxPolicy"]["network"]["limits"]["socketTimeoutMs"] = json!(40);
    let output=fixture.run(&policy,&format!("import assert from 'node:assert/strict';await assert.rejects(fetch('{}/slow'),{{code:'network.timeout'}});",server.origin));
    success(&output);
}

#[test]
fn native_fetch_maps_response_caps_without_collapsing_them_to_offline() {
    let server = Server::new();
    let fixture = Fixture::new();
    let mut policy = Fixture::policy(&server.origin, true);
    policy["sandboxPolicy"]["network"]["limits"]["maxResponseBodyBytes"] = json!(1024);
    let output = fixture.run(&policy, &format!(
        "import assert from 'node:assert/strict';await assert.rejects(fetch('{}/large'),{{code:'network.response_too_large'}});",
        server.origin
    ));
    success(&output);
    let mut headers = Fixture::policy(&server.origin, true);
    headers["sandboxPolicy"]["network"]["limits"]["maxHeaderBytes"] = json!(32);
    let output = fixture.run(&headers, &format!(
        "import assert from 'node:assert/strict';await assert.rejects(fetch('{}/headers'),{{code:'network.response_too_large'}});",
        server.origin
    ));
    success(&output);
}

#[test]
fn native_mock_fetch_uses_host_rules_without_real_transport() {
    let fixture = Fixture::new();
    let mut policy = Fixture::policy("https://api.example", false);
    policy["sandboxPolicy"]["network"]["access"] = json!("mockOnly");
    policy["sandboxPolicy"]["network"]["allowedSchemes"] = json!(["https"]);
    policy["networkRules"] = json!({"mode":"failClosed","rules":[{"id":"mock","priority":1,"match":{"path":{"op":"exact","value":"/mock"}},"action":{"type":"respond","status":200,"body":{"kind":"json","value":{"mock":true}}}}]});
    let output=fixture.run(&policy,r#"
        import assert from 'node:assert/strict';const response=await fetch('https://api.example/mock');assert.deepEqual(await response.json(),{mock:true});await assert.rejects(fetch('https://api.example/unmatched'));console.log('MOCK_OK');
    "#);
    success(&output);
}
