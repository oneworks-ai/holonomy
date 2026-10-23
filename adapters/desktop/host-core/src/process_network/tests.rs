use super::*;
use std::{
    io::{Read, Write},
    net::{TcpListener, UdpSocket as StdUdpSocket},
    thread,
};

fn sync(network: &mut NativeProcessNetwork, value: Value) -> Value {
    let result: Value = serde_json::from_str(&network.sync(&value.to_string())).unwrap();
    assert_eq!(result["ok"], true, "{result}");
    result["value"].clone()
}

fn run(network: &mut NativeProcessNetwork, mut value: Value) -> Value {
    value["deadlineMs"] = json!(network.epoch.elapsed().as_secs_f64() * 1000.0 + 5000.0);
    let id = network.start(&value.to_string()).unwrap();
    for _ in 0..5000 {
        if let Some((_, result)) = network
            .poll()
            .into_iter()
            .find(|(candidate, _)| *candidate == id)
        {
            return result.unwrap();
        }
        thread::sleep(Duration::from_millis(1));
    }
    panic!("Process network task stalled");
}

fn begin(network: &mut NativeProcessNetwork, mut value: Value) -> u64 {
    value["deadlineMs"] = json!(network.epoch.elapsed().as_secs_f64() * 1000.0 + 5000.0);
    network.start(&value.to_string()).unwrap()
}

fn outcome(network: &mut NativeProcessNetwork, id: u64) -> Result<Value> {
    for _ in 0..5000 {
        if let Some((_, result)) = network
            .poll()
            .into_iter()
            .find(|(candidate, _)| *candidate == id)
        {
            return result;
        }
        thread::sleep(Duration::from_millis(1));
    }
    panic!("Process network task stalled");
}

fn wait_until_finished(network: &NativeProcessNetwork, id: u64) {
    for _ in 0..5000 {
        if network.jobs.get(&id).unwrap().task.is_finished() {
            return;
        }
        thread::sleep(Duration::from_millis(1));
    }
    panic!("Process network task stalled");
}

fn read_http_headers(peer: &mut std::net::TcpStream) {
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    while !request.ends_with(b"\r\n\r\n") {
        let size = peer.read(&mut buffer).unwrap();
        assert!(size > 0);
        request.extend_from_slice(&buffer[..size]);
        assert!(request.len() < 16 * 1024);
    }
}

fn installed_at(port: u16, transport: &str) -> NativeProcessNetwork {
    let mut network = NativeProcessNetwork::new(Instant::now());
    sync(
        &mut network,
        json!({
            "schemaVersion": 1, "kind": "installProfile", "generation": 7,
            "policy": {"access":"sandboxed", "network": {
                "access":"restricted", "endpoints":[{
                    "hostname":"127.0.0.1", "ports":[port], "transport":transport
                }], "maxSockets":2, "privateNetwork":"allow"
            }}
        }),
    );
    network
}

fn prepared(network: &mut NativeProcessNetwork, port: u16, transport: &str) -> (String, Value) {
    let semantic = "a".repeat(64);
    let evidence = "b".repeat(64);
    let binding = "c".repeat(64);
    let result = run(
        network,
        json!({
            "schemaVersion":1,"kind":"resolve","generation":7,"environmentId":"vm-1",
            "hostname":"127.0.0.1","port":port,"transport":transport,
            "semanticResourceDigest":semantic
        }),
    );
    let token = result["resolutionToken"].as_str().unwrap().to_owned();
    let verified = run(
        network,
        json!({
            "schemaVersion":1,"kind":"verifyResolution","generation":7,"resolutionToken":token
        }),
    );
    assert_eq!(verified, result);
    sync(
        network,
        json!({
            "schemaVersion":1,"kind":"bindResolution","generation":7,"resolutionToken":token,
            "invocationBindingDigest":binding,"semanticResourceDigest":semantic,
            "evidenceDigest":evidence
        }),
    );
    let receipt = json!({
        "authorized":true,"generation":7,"invocationBindingDigest":binding,
        "semanticResourceDigest":semantic,"resolution":{
            "addresses":result["addresses"], "evidenceDigest":evidence,
            "expiresAtMonotonicMs":result["expiresAtMonotonicMs"],
            "resolverGeneration":7
        }
    });
    (token, receipt)
}

#[test]
fn rejects_process_network_without_a_private_profile() {
    let mut network = NativeProcessNetwork::new(Instant::now());
    let result: Value = serde_json::from_str(
        &network.sync(
            &json!({
                "schemaVersion": 1,
                "kind": "bindResolution",
                "generation": 1,
                "resolutionToken": "resolution-1",
                "invocationBindingDigest": "a".repeat(64),
                "semanticResourceDigest": "b".repeat(64),
                "evidenceDigest": "c".repeat(64)
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert_eq!(result["code"], "resource.stale");
}

#[test]
fn tcp_needs_the_final_bound_receipt_and_uses_one_literal_peer() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let mut network = installed_at(port, "tcp");
    let (token, receipt) = prepared(&mut network, port, "tcp");
    let mut wrong = receipt.clone();
    wrong["invocationBindingDigest"] = json!("d".repeat(64));
    let mut open = json!({
        "schemaVersion":1,"kind":"openTcp","generation":7,"environmentId":"vm-1",
        "resolutionToken":token,"receipt":wrong,"address":"127.0.0.1","port":port
    });
    open["deadlineMs"] = json!(network.epoch.elapsed().as_secs_f64() * 1000.0 + 5000.0);
    assert_eq!(network.start(&open.to_string()), Err("resource.stale"));
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    open["receipt"] = receipt;
    let checked: Receipt = serde_json::from_value(open["receipt"].clone()).unwrap();
    let expected = network.resolutions.get(&token).unwrap();
    assert!(
        valid_receipt(expected, &checked),
        "expected expiry={}, received expiry={}",
        expected.expires_at_ms,
        checked.resolution.expires_at_monotonic_ms
    );
    let reparsed: Value = serde_json::from_str(&open.to_string()).unwrap();
    let checked_again: Receipt = serde_json::from_value(reparsed["receipt"].clone()).unwrap();
    assert!(
        valid_receipt(expected, &checked_again),
        "roundtrip expiry={} expected={}",
        checked_again.resolution.expires_at_monotonic_ms,
        expected.expires_at_ms
    );
    let result = run(&mut network, open.clone());
    assert_eq!(network.start(&open.to_string()), Err("resource.stale"));
    assert_eq!(network.sockets.len(), 1);
    let socket = result["socketToken"].as_str().unwrap();
    let (mut peer, address) = loop {
        match listener.accept() {
            Ok(value) => break value,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(1))
            }
            Err(error) => panic!("{error}"),
        }
    };
    assert_eq!(address.ip().to_string(), "127.0.0.1");
    peer.write_all(b"answer").unwrap();
    let read = run(
        &mut network,
        json!({
            "schemaVersion":1,"kind":"readTcp","generation":7,"socketToken":socket,
            "maxBytes":64
        }),
    );
    assert_eq!(
        STANDARD.decode(read["base64"].as_str().unwrap()).unwrap(),
        b"answer"
    );
    sync(
        &mut network,
        json!({"schemaVersion":1,"kind":"closeEnvironment","generation":7,"environmentId":"vm-1"}),
    );
    assert!(network.sockets.is_empty());
}

#[test]
fn raw_tcp_cannot_consume_a_tls_endpoint_receipt() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut network = installed_at(port, "tls");
    let (token, receipt) = prepared(&mut network, port, "tls");
    let request = json!({
        "schemaVersion":1,"kind":"openTcp","generation":7,"environmentId":"vm-1",
        "resolutionToken":token,"receipt":receipt,"address":"127.0.0.1","port":port,
        "deadlineMs":network.epoch.elapsed().as_secs_f64()*1000.0+5000.0
    });
    assert_eq!(network.start(&request.to_string()), Err("resource.stale"));
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert!(network.sockets.is_empty());
}

#[test]
fn udp_connected_peer_round_trip_and_generation_close() {
    let fixture = StdUdpSocket::bind("127.0.0.1:0").unwrap();
    fixture
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let port = fixture.local_addr().unwrap().port();
    let mut network = installed_at(port, "udp");
    let (token, receipt) = prepared(&mut network, port, "udp");
    let opened = run(
        &mut network,
        json!({
            "schemaVersion":1,"kind":"openUdp","generation":7,"environmentId":"vm-1",
            "resolutionToken":token,"receipt":receipt,"address":"127.0.0.1","port":port
        }),
    );
    let socket = opened["socketToken"].as_str().unwrap();
    let sent = run(
        &mut network,
        json!({
            "schemaVersion":1,"kind":"sendUdp","generation":7,"socketToken":socket,
            "base64":STANDARD.encode(b"ping")
        }),
    );
    assert_eq!(sent["written"], 4);
    let mut buffer = [0; 16];
    let (length, peer) = fixture.recv_from(&mut buffer).unwrap();
    assert_eq!(&buffer[..length], b"ping");
    fixture.send_to(b"pong", peer).unwrap();
    let received = run(
        &mut network,
        json!({
            "schemaVersion":1,"kind":"recvUdp","generation":7,"socketToken":socket,"maxBytes":16
        }),
    );
    assert_eq!(
        STANDARD
            .decode(received["base64"].as_str().unwrap())
            .unwrap(),
        b"pong"
    );
    sync(
        &mut network,
        json!({"schemaVersion":1,"kind":"closeGeneration","generation":7}),
    );
    assert!(network.sockets.is_empty());
    assert!(network.resolutions.is_empty());
}

#[test]
fn http_one_hop_stream_is_pinned_and_has_bounded_pulls() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let peer = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = [0; 1024];
        assert!(socket.read(&mut request).unwrap() > 0);
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello")
            .unwrap();
    });
    let mut network = installed_at(port, "tcp");
    let (token, receipt) = prepared(&mut network, port, "tcp");
    let head = run(
        &mut network,
        json!({
            "schemaVersion":1,"kind":"httpRequest","generation":7,"environmentId":"vm-1",
            "resolutionToken":token,"receipt":receipt,"address":"127.0.0.1",
            "url":format!("http://127.0.0.1:{port}/"),"method":"GET","headers":[],"bodyBase64":""
        }),
    );
    assert_eq!(head["status"], 200);
    let socket = head["socketToken"].as_str().unwrap();
    let pulled = run(
        &mut network,
        json!({
            "schemaVersion":1,"kind":"httpPull","generation":7,"socketToken":socket,"maxBytes":16
        }),
    );
    assert_eq!(
        STANDARD.decode(pulled["base64"].as_str().unwrap()).unwrap(),
        b"hello"
    );
    let done = run(
        &mut network,
        json!({
            "schemaVersion":1,"kind":"httpPull","generation":7,"socketToken":socket,"maxBytes":16
        }),
    );
    assert_eq!(done["eof"], true);
    assert!(network.sockets.is_empty());
    peer.join().unwrap();
}

#[test]
fn private_address_is_rejected_before_a_socket_or_receipt_exists() {
    let mut network = NativeProcessNetwork::new(Instant::now());
    sync(
        &mut network,
        json!({
            "schemaVersion":1,"kind":"installProfile","generation":7,
            "policy":{"access":"sandboxed","network":{"access":"restricted",
                "endpoints":[{"hostname":"127.0.0.1","ports":[8080],"transport":"tcp"}],
                "maxSockets":1,"privateNetwork":"deny"}}
        }),
    );
    let request = json!({"schemaVersion":1,"kind":"resolve","generation":7,
        "environmentId":"vm-1","hostname":"127.0.0.1","port":8080,
        "transport":"tcp","semanticResourceDigest":"a".repeat(64),
        "deadlineMs":network.epoch.elapsed().as_secs_f64()*1000.0+5000.0});
    let id = network.start(&request.to_string()).unwrap();
    let mut outcome = None;
    for _ in 0..1000 {
        if let Some((_, value)) = network
            .poll()
            .into_iter()
            .find(|(candidate, _)| *candidate == id)
        {
            outcome = Some(value);
            break;
        }
        thread::sleep(Duration::from_millis(1));
    }
    assert!(matches!(outcome, Some(Err("policy.denied"))));
    assert!(network.resolutions.is_empty());
    assert!(network.sockets.is_empty());
}

#[test]
fn cancelling_a_queued_dns_completion_cannot_publish_a_resolution() {
    let mut network = installed_at(8080, "tcp");
    let request = json!({"schemaVersion":1,"kind":"resolve","generation":7,
        "environmentId":"vm-1","hostname":"127.0.0.1","port":8080,
        "transport":"tcp","semanticResourceDigest":"a".repeat(64),
        "deadlineMs":network.epoch.elapsed().as_secs_f64()*1000.0+5000.0});
    let id = network.start(&request.to_string()).unwrap();
    for _ in 0..1000 {
        if network.jobs.get(&id).unwrap().task.is_finished() {
            break;
        }
        thread::sleep(Duration::from_millis(1));
    }
    assert!(network.jobs.get(&id).unwrap().task.is_finished());
    network.cancel(id);
    assert!(
        matches!(network.poll().as_slice(), [(candidate, Err("runtime.cancelled"))] if *candidate == id)
    );
    assert!(network.resolutions.is_empty());
}

#[test]
fn http_redirect_is_returned_to_host_without_following_its_target() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    target.set_nonblocking(true).unwrap();
    let target_port = target.local_addr().unwrap().port();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let peer = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = [0; 1024];
        assert!(socket.read(&mut request).unwrap() > 0);
        let response = format!(
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target_port}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        socket.write_all(response.as_bytes()).unwrap();
    });
    let mut network = installed_at(port, "tcp");
    let (token, receipt) = prepared(&mut network, port, "tcp");
    let head = run(
        &mut network,
        json!({
            "schemaVersion":1,"kind":"httpRequest","generation":7,"environmentId":"vm-1",
            "resolutionToken":token,"receipt":receipt,"address":"127.0.0.1",
            "url":format!("http://127.0.0.1:{port}/"),"method":"GET","headers":[],"bodyBase64":""
        }),
    );
    assert_eq!(head["status"], 302);
    assert_eq!(
        target.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    peer.join().unwrap();
}

#[test]
fn address_evidence_uses_javascript_string_order_and_canonical_mapped_ipv6() {
    let addresses = canonical_addresses(
        vec![
            "192.0.2.2".parse().unwrap(),
            "::ffff:127.0.0.1".parse().unwrap(),
            "192.0.2.10".parse().unwrap(),
            "192.0.2.2".parse().unwrap(),
        ],
        true,
    )
    .unwrap();
    assert_eq!(
        addresses.iter().map(canonical_ip).collect::<Vec<_>>(),
        vec!["192.0.2.10", "192.0.2.2", "::ffff:7f00:1"]
    );
    assert_eq!(
        canonical_addresses(
            vec!["8.8.8.8".parse().unwrap(), "127.0.0.1".parse().unwrap()],
            false
        ),
        Err("policy.denied")
    );
}

#[test]
fn cancelled_dns_caller_does_not_release_a_running_os_lookup_slot() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let slots = Arc::new(Semaphore::new(1));
    let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let (started_send, started_receive) = std::sync::mpsc::channel();
    let held = Arc::clone(&gate);
    let first = runtime.spawn(physical_dns_lookup(Arc::clone(&slots), move || {
        started_send.send(()).unwrap();
        let (lock, condition) = &*held;
        let mut released = lock.lock().unwrap();
        while !*released {
            released = condition.wait(released).unwrap();
        }
        Ok(vec!["127.0.0.1".parse().unwrap()])
    }));
    started_receive
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    first.abort();
    assert!(runtime.block_on(first).unwrap_err().is_cancelled());
    assert_eq!(slots.available_permits(), 0);
    let second = runtime.spawn(physical_dns_lookup(Arc::clone(&slots), || {
        Ok(vec!["127.0.0.1".parse().unwrap()])
    }));
    thread::sleep(Duration::from_millis(20));
    assert!(!second.is_finished());
    let (lock, condition) = &*gate;
    *lock.lock().unwrap() = true;
    condition.notify_all();
    assert_eq!(runtime.block_on(second).unwrap().unwrap().len(), 1);
    assert_eq!(slots.available_permits(), 1);
}

#[test]
fn installing_a_new_generation_does_not_wait_for_cancelled_physical_dns() {
    let mut network = installed_at(8080, "tcp");
    let slots = Arc::clone(&network.physical_dns_slots);
    let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let (started_send, started_receive) = std::sync::mpsc::channel();
    let held = Arc::clone(&gate);
    let _lookup = network.runtime.as_ref().unwrap().spawn(physical_dns_lookup(
        Arc::clone(&slots),
        move || {
            started_send.send(()).unwrap();
            let (lock, condition) = &*held;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = condition.wait(released).unwrap();
            }
            Ok(vec!["127.0.0.1".parse().unwrap()])
        },
    ));
    started_receive
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    sync(
        &mut network,
        json!({"schemaVersion":1,"kind":"closeGeneration","generation":7}),
    );
    assert_eq!(slots.available_permits(), MAX_LOOKUPS - 1);

    let (finished_send, finished_receive) = std::sync::mpsc::channel();
    let installer = thread::spawn(move || {
        let result = network.sync(
            &json!({
                "schemaVersion":1,"kind":"installProfile","generation":8,
                "policy":{"access":"sandboxed","network":{"access":"restricted",
                    "endpoints":[{"hostname":"127.0.0.1","ports":[8080],"transport":"tcp"}],
                    "maxSockets":2,"privateNetwork":"allow"}}
            })
            .to_string(),
        );
        finished_send.send(result).unwrap();
        network
    });
    let promptly = finished_receive.recv_timeout(Duration::from_secs(1));
    assert_eq!(slots.available_permits(), MAX_LOOKUPS - 1);
    let (lock, condition) = &*gate;
    *lock.lock().unwrap() = true;
    condition.notify_all();
    let network = installer.join().unwrap();
    assert!(promptly.is_ok(), "new generation waited for physical DNS");
    assert_eq!(network.profile.as_ref().unwrap().generation, 8);
}

#[test]
fn cancelled_tcp_read_and_write_release_flags_and_queued_bytes() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut network = installed_at(port, "tcp");
    let (resolution_token, receipt) = prepared(&mut network, port, "tcp");
    let opened = run(
        &mut network,
        json!({"schemaVersion":1,"kind":"openTcp","generation":7,
            "environmentId":"vm-1","resolutionToken":resolution_token,
            "receipt":receipt,"address":"127.0.0.1","port":port}),
    );
    let token = opened["socketToken"].as_str().unwrap().to_owned();
    let (mut peer, _) = listener.accept().unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();

    let read_id = begin(
        &mut network,
        json!({"schemaVersion":1,"kind":"readTcp","generation":7,
            "socketToken":token,"maxBytes":16}),
    );
    assert!(network.sockets[&token].pending_read);
    network.cancel(read_id);
    assert!(matches!(
        outcome(&mut network, read_id),
        Err("runtime.cancelled")
    ));
    assert!(!network.sockets[&token].pending_read);
    peer.write_all(b"ok").unwrap();
    let read = run(
        &mut network,
        json!({"schemaVersion":1,"kind":"readTcp","generation":7,
            "socketToken":token,"maxBytes":16}),
    );
    assert_eq!(
        STANDARD.decode(read["base64"].as_str().unwrap()).unwrap(),
        b"ok"
    );

    let write = match &network.sockets[&token].kind {
        SocketKind::Tcp { write, .. } => Arc::clone(write),
        _ => panic!("expected TCP socket"),
    };
    let held = network
        .runtime
        .as_ref()
        .unwrap()
        .block_on(write.lock_owned());
    let write_id = begin(
        &mut network,
        json!({"schemaVersion":1,"kind":"writeTcp","generation":7,
            "socketToken":token,"base64":STANDARD.encode(b"lost")}),
    );
    assert_eq!(network.queued_bytes, 4);
    assert!(network.sockets[&token].pending_write);
    network.cancel(write_id);
    wait_until_finished(&network, write_id);
    assert!(matches!(
        outcome(&mut network, write_id),
        Err("runtime.cancelled")
    ));
    assert_eq!(network.queued_bytes, 0);
    assert_eq!(network.sockets[&token].queued_bytes, 0);
    assert!(!network.sockets[&token].pending_write);
    drop(held);
    let written = run(
        &mut network,
        json!({"schemaVersion":1,"kind":"writeTcp","generation":7,
            "socketToken":token,"base64":STANDARD.encode(b"safe")}),
    );
    assert_eq!(written["written"], 4);
    let mut bytes = [0; 4];
    peer.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"safe");
}

#[test]
fn environment_close_discards_a_completed_tcp_open_before_poll() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut network = installed_at(port, "tcp");
    let (resolution_token, receipt) = prepared(&mut network, port, "tcp");
    let id = begin(
        &mut network,
        json!({"schemaVersion":1,"kind":"openTcp","generation":7,
            "environmentId":"vm-1","resolutionToken":resolution_token,
            "receipt":receipt,"address":"127.0.0.1","port":port}),
    );
    let (mut peer, _) = listener.accept().unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    wait_until_finished(&network, id);
    sync(
        &mut network,
        json!({"schemaVersion":1,"kind":"closeEnvironment",
        "generation":7,"environmentId":"vm-1"}),
    );
    assert!(matches!(
        outcome(&mut network, id),
        Err("runtime.cancelled")
    ));
    assert!(network.sockets.is_empty());
    assert_eq!(network.openings, 0);
    let mut byte = [0];
    assert_eq!(peer.read(&mut byte).unwrap(), 0);
}

#[test]
fn cancelling_an_http_open_waiting_for_head_releases_its_slot_and_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (seen_send, seen_receive) = std::sync::mpsc::channel();
    let (release_send, release_receive) = std::sync::mpsc::channel();
    let server = thread::spawn(move || {
        let (mut peer, _) = listener.accept().unwrap();
        read_http_headers(&mut peer);
        seen_send.send(()).unwrap();
        release_receive
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        let mut byte = [0];
        assert_eq!(peer.read(&mut byte).unwrap(), 0);
    });
    let mut network = installed_at(port, "tcp");
    let (resolution_token, receipt) = prepared(&mut network, port, "tcp");
    let id = begin(
        &mut network,
        json!({"schemaVersion":1,"kind":"httpRequest","generation":7,
            "environmentId":"vm-1","resolutionToken":resolution_token,"receipt":receipt,
            "address":"127.0.0.1","url":format!("http://127.0.0.1:{port}/"),
            "method":"GET","headers":[],"bodyBase64":""}),
    );
    seen_receive.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(network.openings, 1);
    network.cancel(id);
    assert!(matches!(
        outcome(&mut network, id),
        Err("runtime.cancelled")
    ));
    assert_eq!(network.openings, 0);
    assert!(network.sockets.is_empty());
    release_send.send(()).unwrap();
    server.join().unwrap();
}

#[test]
fn cancelling_an_http_pull_waiting_for_body_closes_the_response() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (head_send, head_receive) = std::sync::mpsc::channel();
    let (release_send, release_receive) = std::sync::mpsc::channel();
    let server = thread::spawn(move || {
        let (mut peer, _) = listener.accept().unwrap();
        read_http_headers(&mut peer);
        peer.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n")
            .unwrap();
        head_send.send(()).unwrap();
        release_receive
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        let mut byte = [0];
        assert_eq!(peer.read(&mut byte).unwrap(), 0);
    });
    let mut network = installed_at(port, "tcp");
    let (resolution_token, receipt) = prepared(&mut network, port, "tcp");
    let head = run(
        &mut network,
        json!({"schemaVersion":1,"kind":"httpRequest","generation":7,
            "environmentId":"vm-1","resolutionToken":resolution_token,"receipt":receipt,
            "address":"127.0.0.1","url":format!("http://127.0.0.1:{port}/"),
            "method":"GET","headers":[],"bodyBase64":""}),
    );
    head_receive.recv_timeout(Duration::from_secs(2)).unwrap();
    let token = head["socketToken"].as_str().unwrap().to_owned();
    let id = begin(
        &mut network,
        json!({"schemaVersion":1,"kind":"httpPull",
        "generation":7,"socketToken":token,"maxBytes":16}),
    );
    assert!(network.sockets[&token].pending_read);
    network.cancel(id);
    assert!(matches!(
        outcome(&mut network, id),
        Err("runtime.cancelled")
    ));
    assert!(network.sockets.is_empty());
    assert_eq!(
        network.start(
            &json!({"schemaVersion":1,"kind":"httpPull",
        "generation":7,"socketToken":token,"maxBytes":16,
        "deadlineMs":network.epoch.elapsed().as_secs_f64()*1000.0+5000.0})
            .to_string()
        ),
        Err("resource.stale")
    );
    release_send.send(()).unwrap();
    server.join().unwrap();
}

#[test]
fn generation_close_discards_a_queued_resolution_completion() {
    let mut network = installed_at(8080, "tcp");
    let id = begin(
        &mut network,
        json!({"schemaVersion":1,"kind":"resolve",
        "generation":7,"environmentId":"vm-1","hostname":"127.0.0.1",
        "port":8080,"transport":"tcp","semanticResourceDigest":"a".repeat(64)}),
    );
    wait_until_finished(&network, id);
    sync(
        &mut network,
        json!({"schemaVersion":1,"kind":"closeGeneration","generation":7}),
    );
    assert!(matches!(
        outcome(&mut network, id),
        Err("runtime.cancelled")
    ));
    assert_eq!(network.lookups, 0);
    assert!(network.resolutions.is_empty());
    assert!(network.profile.is_none());
}

#[test]
fn udp_oversized_datagram_is_discarded_without_poisoning_the_socket() {
    let fixture = StdUdpSocket::bind("127.0.0.1:0").unwrap();
    fixture
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let port = fixture.local_addr().unwrap().port();
    let mut network = installed_at(port, "udp");
    let (resolution_token, receipt) = prepared(&mut network, port, "udp");
    let opened = run(
        &mut network,
        json!({"schemaVersion":1,"kind":"openUdp",
        "generation":7,"environmentId":"vm-1","resolutionToken":resolution_token,
        "receipt":receipt,"address":"127.0.0.1","port":port}),
    );
    let token = opened["socketToken"].as_str().unwrap().to_owned();
    run(
        &mut network,
        json!({"schemaVersion":1,"kind":"sendUdp","generation":7,
        "socketToken":token,"base64":STANDARD.encode(b"ping")}),
    );
    let mut buffer = [0; 16];
    let (_, peer) = fixture.recv_from(&mut buffer).unwrap();
    fixture.send_to(b"long", peer).unwrap();
    let id = begin(
        &mut network,
        json!({"schemaVersion":1,"kind":"recvUdp",
        "generation":7,"socketToken":token,"maxBytes":2}),
    );
    assert!(matches!(
        outcome(&mut network, id),
        Err("resource.byte_limit")
    ));
    assert!(!network.sockets[&token].pending_read);
    fixture.send_to(b"ok", peer).unwrap();
    let received = run(
        &mut network,
        json!({"schemaVersion":1,"kind":"recvUdp",
        "generation":7,"socketToken":token,"maxBytes":2}),
    );
    assert_eq!(
        STANDARD
            .decode(received["base64"].as_str().unwrap())
            .unwrap(),
        b"ok"
    );
}

#[test]
fn expired_receipt_cannot_open_a_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut network = installed_at(port, "tcp");
    let (resolution_token, receipt) = prepared(&mut network, port, "tcp");
    network
        .resolutions
        .get_mut(&resolution_token)
        .unwrap()
        .expires = Instant::now() - Duration::from_millis(1);
    let request = json!({"schemaVersion":1,"kind":"openTcp","generation":7,
        "environmentId":"vm-1","resolutionToken":resolution_token,"receipt":receipt,
        "address":"127.0.0.1","port":port,
        "deadlineMs":network.epoch.elapsed().as_secs_f64()*1000.0+5000.0});
    assert_eq!(network.start(&request.to_string()), Err("resource.stale"));
    assert!(network.sockets.is_empty());
    assert_eq!(network.openings, 0);
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn http_response_header_count_releases_opening_without_publishing_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut peer, _) = listener.accept().unwrap();
        read_http_headers(&mut peer);
        let mut response = String::from("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n");
        for index in 0..64 {
            response.push_str(&format!("x-extra-{index}: value\r\n"));
        }
        response.push_str("\r\n");
        peer.write_all(response.as_bytes()).unwrap();
    });
    let mut network = installed_at(port, "tcp");
    let (resolution_token, receipt) = prepared(&mut network, port, "tcp");
    let id = begin(
        &mut network,
        json!({"schemaVersion":1,"kind":"httpRequest",
        "generation":7,"environmentId":"vm-1","resolutionToken":resolution_token,
        "receipt":receipt,"address":"127.0.0.1",
        "url":format!("http://127.0.0.1:{port}/"),"method":"GET",
        "headers":[],"bodyBase64":""}),
    );
    assert!(matches!(
        outcome(&mut network, id),
        Err("resource.byte_limit")
    ));
    assert_eq!(network.openings, 0);
    assert!(network.sockets.is_empty());
    server.join().unwrap();
}

#[test]
fn http_stream_total_limit_closes_the_response_on_pull() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut peer, _) = listener.accept().unwrap();
        read_http_headers(&mut peer);
        peer.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc")
            .unwrap();
    });
    let mut network = installed_at(port, "tcp");
    let (resolution_token, receipt) = prepared(&mut network, port, "tcp");
    let head = run(
        &mut network,
        json!({"schemaVersion":1,"kind":"httpRequest",
        "generation":7,"environmentId":"vm-1","resolutionToken":resolution_token,
        "receipt":receipt,"address":"127.0.0.1",
        "url":format!("http://127.0.0.1:{port}/"),"method":"GET",
        "headers":[],"bodyBase64":""}),
    );
    let token = head["socketToken"].as_str().unwrap().to_owned();
    let body = match &network.sockets[&token].kind {
        SocketKind::Http(body) => Arc::clone(body),
        _ => panic!("expected HTTP response"),
    };
    network.runtime.as_ref().unwrap().block_on(async {
        body.lock().await.total = MAX_HTTP_BODY;
    });
    let id = begin(
        &mut network,
        json!({"schemaVersion":1,"kind":"httpPull",
        "generation":7,"socketToken":token,"maxBytes":16}),
    );
    assert!(matches!(
        outcome(&mut network, id),
        Err("resource.byte_limit")
    ));
    assert!(network.sockets.is_empty());
    server.join().unwrap();
}

#[test]
fn queued_tcp_write_rejection_preserves_capacity_and_socket_state() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut network = installed_at(port, "tcp");
    let (resolution_token, receipt) = prepared(&mut network, port, "tcp");
    let opened = run(
        &mut network,
        json!({"schemaVersion":1,"kind":"openTcp",
        "generation":7,"environmentId":"vm-1","resolutionToken":resolution_token,
        "receipt":receipt,"address":"127.0.0.1","port":port}),
    );
    let token = opened["socketToken"].as_str().unwrap().to_owned();
    let (mut peer, _) = listener.accept().unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let request = json!({"schemaVersion":1,"kind":"writeTcp","generation":7,
        "socketToken":token,"base64":STANDARD.encode(b"safe"),
        "deadlineMs":network.epoch.elapsed().as_secs_f64()*1000.0+5000.0});
    network.queued_bytes = MAX_QUEUED_TOTAL - 1;
    assert_eq!(
        network.start(&request.to_string()),
        Err("resource.byte_limit")
    );
    assert_eq!(network.queued_bytes, MAX_QUEUED_TOTAL - 1);
    assert_eq!(network.sockets[&token].queued_bytes, 0);
    assert!(!network.sockets[&token].pending_write);
    network.queued_bytes = 0;
    let written = run(&mut network, request);
    assert_eq!(written["written"], 4);
    let mut bytes = [0; 4];
    peer.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"safe");
}

#[test]
fn exhausted_job_ids_do_not_reserve_a_write_or_consume_an_open_receipt() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut network = installed_at(port, "tcp");
    let (resolution_token, receipt) = prepared(&mut network, port, "tcp");
    let opened = run(
        &mut network,
        json!({"schemaVersion":1,"kind":"openTcp",
        "generation":7,"environmentId":"vm-1","resolutionToken":resolution_token,
        "receipt":receipt,"address":"127.0.0.1","port":port}),
    );
    let token = opened["socketToken"].as_str().unwrap().to_owned();
    let (_peer, _) = listener.accept().unwrap();
    network.next = MAX_SAFE_ID;
    let write = json!({"schemaVersion":1,"kind":"writeTcp","generation":7,
        "socketToken":token,"base64":STANDARD.encode(b"lost"),
        "deadlineMs":network.epoch.elapsed().as_secs_f64()*1000.0+5000.0});
    assert_eq!(network.start(&write.to_string()), Err("provider.quota"));
    assert!(!network.sockets[&token].pending_write);
    assert_eq!(network.sockets[&token].queued_bytes, 0);
    assert_eq!(network.queued_bytes, 0);

    network.next = 100;
    let (second_token, second_receipt) = prepared(&mut network, port, "tcp");
    network.next = MAX_SAFE_ID - 1;
    let open = json!({"schemaVersion":1,"kind":"openTcp","generation":7,
        "environmentId":"vm-1","resolutionToken":second_token,
        "receipt":second_receipt,"address":"127.0.0.1","port":port,
        "deadlineMs":network.epoch.elapsed().as_secs_f64()*1000.0+5000.0});
    assert_eq!(network.start(&open.to_string()), Err("provider.quota"));
    assert!(network.resolutions.contains_key(&second_token));
    assert_eq!(network.openings, 0);
}
