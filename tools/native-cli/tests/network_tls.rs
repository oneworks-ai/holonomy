use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

#[test]
fn native_https_verifies_certificates_and_hostnames_with_explicit_host_roots() {
    let certificate = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![certificate.cert.der().clone()],
            rustls::pki_types::PrivatePkcs8KeyDer::from(certificate.signing_key.serialize_der())
                .into(),
        )
        .unwrap();
    let config = Arc::new(config);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let requests = Arc::new(AtomicUsize::new(0));
    let worker_stop = stop.clone();
    let worker_requests = requests.clone();
    let worker = thread::spawn(move || {
        let mut workers = Vec::new();
        while !worker_stop.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let config = config.clone();
                    let requests = worker_requests.clone();
                    workers.push(thread::spawn(move || {
                        let connection = rustls::ServerConnection::new(config).unwrap();
                        let mut stream = rustls::StreamOwned::new(connection, stream);
                        let mut bytes = Vec::new();
                        let mut buffer = [0; 1024];
                        loop {
                            match stream.read(&mut buffer) {
                                Ok(0) | Err(_) => return,
                                Ok(n) => bytes.extend_from_slice(&buffer[..n]),
                            }
                            if bytes.windows(4).any(|value| value == b"\r\n\r\n") {
                                break;
                            }
                            if bytes.len() > 8192 {
                                return;
                            }
                        }
                        requests.fetch_add(1, Ordering::Relaxed);
                        let _ = stream.write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nTLS_OK",
                        );
                        let _ = stream.flush();
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
    let directory = std::env::temp_dir().join(format!("holo-native-tls-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    let origin = format!("https://localhost:{port}");
    let base = json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2,"network":{"access":"restricted","allowedOrigins":[origin],"allowedSchemes":["https"],"allowPrivateNetwork":true,"limits":{"maxChunkBytes":1024,"maxConcurrentConnections":2,"maxHeaderBytes":4096,"maxHeaders":32,"maxRedirects":5,"maxRequestBodyBytes":4096,"maxResponseBodyBytes":4096,"maxUrlBytes":4096,"socketTimeoutMs":1000},"requestBodyInspection":{"access":"none"}}}});
    let run = |configuration: &Value, source: &str| {
        fs::write(directory.join("host.json"), configuration.to_string()).unwrap();
        fs::write(directory.join("entry.mjs"), source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args([
                "--timeout",
                "5000",
                "--host-config",
                "host.json",
                "entry.mjs",
            ])
            .current_dir(&directory)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .output()
            .unwrap()
    };
    let outcome = || {
        let denied = run(
            &base,
            &format!(
                "import assert from 'node:assert/strict';await assert.rejects(fetch('{origin}/'));"
            ),
        );
        assert!(
            denied.status.success(),
            "{}",
            String::from_utf8_lossy(&denied.stderr)
        );
        assert_eq!(requests.load(Ordering::Relaxed), 0);
        let mut trusted = base.clone();
        trusted["networkTrustRoots"] = json!([certificate.cert.pem()]);
        let allowed = run(
            &trusted,
            &format!(
                "import assert from 'node:assert/strict';assert.equal(await(await fetch('{origin}/')).text(),'TLS_OK');"
            ),
        );
        assert!(
            allowed.status.success(),
            "{}",
            String::from_utf8_lossy(&allowed.stderr)
        );
        assert_eq!(requests.load(Ordering::Relaxed), 1);
        let wrong = format!("https://127.0.0.1:{port}");
        trusted["sandboxPolicy"]["network"]["allowedOrigins"] = json!([wrong]);
        let mismatch = run(
            &trusted,
            &format!(
                "import assert from 'node:assert/strict';await assert.rejects(fetch('{wrong}/'));"
            ),
        );
        assert!(
            mismatch.status.success(),
            "{}",
            String::from_utf8_lossy(&mismatch.stderr)
        );
        assert_eq!(requests.load(Ordering::Relaxed), 1);
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(outcome));
    stop.store(true, Ordering::Release);
    worker.join().unwrap();
    let _ = fs::remove_dir_all(directory);
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
