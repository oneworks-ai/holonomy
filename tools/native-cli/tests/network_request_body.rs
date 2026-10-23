use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    process::{Command, Output},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
static NATIVE_CASE: Mutex<()> = Mutex::new(());

struct Server {
    origin: String,
    hits: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let worker_hits = hits.clone();
        let worker_stop = stop.clone();
        let thread = thread::spawn(move || {
            while !worker_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // macOS accepted sockets can inherit the listener's O_NONBLOCK.
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(10)))
                            .unwrap();
                        let mut bytes = Vec::new();
                        let mut buffer = [0; 8192];
                        let header_end = loop {
                            match stream.read(&mut buffer) {
                                Ok(0) | Err(_) => break None,
                                Ok(n) => bytes.extend_from_slice(&buffer[..n]),
                            }
                            if let Some(index) =
                                bytes.windows(4).position(|part| part == b"\r\n\r\n")
                            {
                                break Some(index + 4);
                            }
                            if bytes.len() > 65536 {
                                break None;
                            }
                        };
                        let Some(header_end) = header_end else {
                            continue;
                        };
                        let headers = String::from_utf8_lossy(&bytes[..header_end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if length > 2 * 1024 * 1024 {
                            continue;
                        }
                        while bytes.len() < header_end + length {
                            match stream.read(&mut buffer) {
                                Ok(0) | Err(_) => break,
                                Ok(n) => bytes.extend_from_slice(&buffer[..n]),
                            }
                        }
                        if bytes.len() != header_end + length {
                            continue;
                        }
                        worker_hits.fetch_add(1, Ordering::AcqRel);
                        let response =
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";
                        let _ = stream.write_all(response);
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
            hits,
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

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-network-body-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn run(&self, config: Value, plugin: &str, entry: &str) -> Output {
        fs::write(self.0.join("host.json"), config.to_string()).unwrap();
        fs::write(self.0.join("plugin.mjs"), plugin).unwrap();
        fs::write(self.0.join("entry.mjs"), entry).unwrap();
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args([
                "--timeout",
                "15000",
                "--host-config",
                "host.json",
                "entry.mjs",
            ])
            .current_dir(&self.0)
            .env_clear()
            .env("PATH", "")
            .output()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn config(origin: &str, inspection: Value, reader: Option<(u32, u32)>) -> Value {
    let mut config = json!({
        "schemaVersion": 1,
        "sandboxPolicy": {"schemaVersion": 2, "network": {
            "access": "restricted",
            "allowedOrigins": [origin],
            "allowedSchemes": ["http"],
            "allowPrivateNetwork": true,
            "limits": {"maxChunkBytes": 65536, "maxConcurrentConnections": 1,
                "maxHeaderBytes": 4096, "maxHeaders": 32, "maxRedirects": 0,
                "maxRequestBodyBytes": 2 * 1024 * 1024, "maxResponseBodyBytes": 65536,
                "maxUrlBytes": 4096, "socketTimeoutMs": 10000},
            "requestBodyInspection": inspection
        }},
        "plugins": [{"id": "inspect", "use": "./plugin.mjs"}]
    });
    if let Some((bytes, reads)) = reader {
        config["networkRequestBodyReader"] = json!({
            "capabilityName": "host.network.request-body.read",
            "maxReadBytes": bytes,
            "maxReads": reads
        });
    }
    config
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
fn native_post_reader_is_exact_bounded_one_shot_and_denial_has_no_provider_effect() {
    let _case = NATIVE_CASE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let server = Server::new();
    let fixture = Fixture::new();
    let output = fixture.run(
        config(&server.origin, json!({"access":"bounded","maxBytes":32,"maxReadsPerRuntime":2}), Some((12, 2))),
        r#"
        export default context => {
          let calls = 0, stale;
          context.holo.intercept({operation:'network.fetch.request'}, async (request,next) => {
            const reader = request.hostBindings?.find(value => value.kind === 'networkRequestBodyReader');
            if (++calls === 1) {
              if (reader == null || reader.bodySha256 !== request.arguments.body.sha256 ||
                  reader.requestId !== request.requestId) return context.holo.deny(request);
              const bytes = await reader.read({maxBytes:100});
              if (new TextDecoder().decode(bytes) !== 'posted-body!') return context.holo.deny(request);
              let reused = false;
              try { await reader.read({maxBytes:1}); } catch { reused = true; }
              if (!reused) return context.holo.deny(request);
              stale = reader;
              return next();
            }
            let lateRejected = false;
            try { await stale.read({maxBytes:1}); } catch { lateRejected = true; }
            if (!lateRejected) return next();
            return context.holo.deny(request);
          });
        };
        "#,
        &format!(r#"
        import assert from 'node:assert/strict';
        assert.equal(await (await fetch('{0}/first',{{method:'POST',body:'posted-body!'}})).text(),'ok');
        await assert.rejects(fetch('{0}/denied',{{method:'POST',body:'deny-me'}}),{{code:'holo.permission_denied'}});
        console.log('NATIVE_BODY_READER_OK');
        "#, server.origin),
    );
    success(&output);
    assert_eq!(server.hits.load(Ordering::Acquire), 1);
    assert!(String::from_utf8_lossy(&output.stdout).contains("NATIVE_BODY_READER_OK"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("posted-body!"));
}

#[test]
fn bounded_policy_without_selection_is_metadata_only_and_post_succeeds() {
    let _case = NATIVE_CASE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let server = Server::new();
    let output = Fixture::new().run(
        config(&server.origin, json!({"access":"bounded","maxBytes":1024*1024,"maxReadsPerRuntime":1}), None),
        "export default c=>{c.holo.intercept({operation:'network.fetch.request'},(r,n)=>r.hostBindings?.some(b=>b.kind==='networkRequestBodyReader')?c.holo.deny(r):n());};",
        &format!(r#"
        import assert from 'node:assert/strict';
        assert.equal(await (await fetch('{0}/metadata-only',{{method:'POST',body:'metadata-only'}})).text(),'ok');
        console.log('METADATA_ONLY_BODY_OK');
        "#, server.origin),
    );
    success(&output);
    assert_eq!(server.hits.load(Ordering::Acquire), 1);
}

#[test]
fn selected_reader_under_none_policy_fails_before_guest_or_provider() {
    let _case = NATIVE_CASE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let server = Server::new();
    let output = Fixture::new().run(
        config(&server.origin, json!({"access":"none"}), Some((16, 1))),
        "export default ()=>{};",
        "console.log('GUEST_MUST_NOT_RUN');",
    );
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("GUEST_MUST_NOT_RUN"));
    assert_eq!(server.hits.load(Ordering::Acquire), 0);
}

#[test]
fn selected_small_cap_exposes_metadata_only_when_body_exceeds_cap() {
    let _case = NATIVE_CASE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let server = Server::new();
    let output = Fixture::new().run(
        config(&server.origin, json!({"access":"bounded","maxBytes":32,"maxReadsPerRuntime":1}), Some((8, 1))),
        "export default c=>{c.holo.intercept({operation:'network.fetch.request'},(r,n)=>r.hostBindings?.length?c.holo.deny(r):n());};",
        &format!(r#"
        import assert from 'node:assert/strict';
        assert.equal(await (await fetch('{0}/small-cap',{{method:'POST',body:'ninebytes'}})).text(),'ok');
        console.log('SMALL_CAP_METADATA_ONLY');
        "#, server.origin),
    );
    success(&output);
    assert_eq!(server.hits.load(Ordering::Acquire), 1);
}

#[test]
fn reader_transfer_limit_does_not_limit_large_ordinary_post() {
    let _case = NATIVE_CASE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let server = Server::new();
    for selection in [None, Some((16, 1))] {
        let output = Fixture::new().run(
            config(&server.origin, json!({"access":"bounded","maxBytes":32,"maxReadsPerRuntime":1}), selection),
            "export default c=>{c.holo.intercept({operation:'network.fetch.request'},(r,n)=>r.hostBindings?.length?c.holo.deny(r):n());};",
            &format!(r#"
            import assert from 'node:assert/strict';
            assert.equal(await (await fetch('{0}/large',{{method:'POST',body:'x'.repeat(1024*1024+1)}})).text(),'ok');
            console.log('LARGE_POST_OK');
            "#, server.origin),
        );
        success(&output);
    }
    assert_eq!(server.hits.load(Ordering::Acquire), 2);
}

fn late_reader_case(abort: bool) {
    let _case = NATIVE_CASE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let server = Server::new();
    let plugin = r#"
        export default context => {
          let count = 0, lateRejected = false;
          context.holo.intercept({operation:'network.fetch.request'}, async (request,next) => {
            if (++count === 1) {
              const reader = request.hostBindings?.find(value => value.kind === 'networkRequestBodyReader');
              if (reader == null) return context.holo.deny(request);
              await new Promise(resolve => setTimeout(resolve, 100));
              try { await reader.read({maxBytes:6}); } catch { lateRejected = true; }
              return context.holo.deny(request);
            }
            if (!lateRejected) return context.holo.deny(request);
            return next();
          }, {timeoutMs: TIMEOUT});
        };
    "#
    .replace("TIMEOUT", if abort { "200" } else { "20" });
    let first = if abort {
        format!(
            "const controller=new AbortController();const pending=fetch('{}/cancel',{{method:'POST',body:'cancel',signal:controller.signal}});await new Promise(r=>setTimeout(r,50));controller.abort();await assert.rejects(pending);",
            server.origin
        )
    } else {
        format!(
            "await assert.rejects(fetch('{}/deadline',{{method:'POST',body:'cancel'}}));",
            server.origin
        )
    };
    let entry = format!(
        "import assert from 'node:assert/strict';{first}await new Promise(r=>setTimeout(r,130));assert.equal(await(await fetch('{}/after',{{method:'POST',body:'allowed'}})).text(),'ok');console.log('LATE_READER_OK');",
        server.origin
    );
    let output = Fixture::new().run(
        config(
            &server.origin,
            json!({"access":"bounded","maxBytes":16,"maxReadsPerRuntime":2}),
            Some((16, 2)),
        ),
        &plugin,
        &entry,
    );
    success(&output);
    assert_eq!(server.hits.load(Ordering::Acquire), 1);
    assert!(String::from_utf8_lossy(&output.stdout).contains("LATE_READER_OK"));
}

#[test]
fn abort_revokes_reader_before_late_plugin_resume_and_provider() {
    late_reader_case(true);
}

#[test]
fn middleware_deadline_revokes_reader_before_late_plugin_resume_and_provider() {
    late_reader_case(false);
}
