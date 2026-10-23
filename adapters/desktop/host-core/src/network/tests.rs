use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
};

struct Server {
    origin: String,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl Server {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let token = stop.clone();
        let worker = std::thread::spawn(move || {
            while !token.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        socket
                            .set_read_timeout(Some(Duration::from_millis(100)))
                            .unwrap();
                        let mut request = Vec::new();
                        let mut chunk = [0u8; 1024];
                        let deadline = Instant::now() + Duration::from_secs(2);
                        while request.len() < 8192 && Instant::now() < deadline {
                            let remaining = (8192 - request.len()).min(chunk.len());
                            match socket.read(&mut chunk[..remaining]) {
                                Ok(0) => break,
                                Ok(count) => request.extend_from_slice(&chunk[..count]),
                                Err(error)
                                    if matches!(
                                        error.kind(),
                                        std::io::ErrorKind::WouldBlock
                                            | std::io::ErrorKind::TimedOut
                                    ) => {}
                                Err(_) => break,
                            }
                            if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                                break;
                            }
                        }
                        if !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                            continue; // A cancelled or truncated request gets no HTTP response.
                        }
                        let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nabcdefgh");
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            origin,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.worker.take().unwrap().join();
    }
}

fn network(server: &Server) -> NativeNetwork {
    let mut network = NativeNetwork::new(Instant::now());
    let result: Value = serde_json::from_str(&network.sync(&json!({"kind":"install","policy":{
        "access":"restricted","allowedOrigins":[server.origin],"allowedSchemes":["http"],"allowPrivateNetwork":true,
        "limits":{"maxChunkBytes":2,"maxConcurrentConnections":2,"maxHeaderBytes":4096,"maxHeaders":32,
            "maxRedirects":0,"maxRequestBodyBytes":1024,"maxResponseBodyBytes":1024,"maxUrlBytes":4096,"socketTimeoutMs":1000},
        "requestBodyInspection":{"access":"none"}}}).to_string())).unwrap();
    assert_eq!(result["ok"], true);
    network
}
fn request(network: &mut NativeNetwork, server: &Server, binding: &str) -> u64 {
    network.bindings.insert(
        binding.into(),
        Binding {
            used: false,
            resolution: Resolution {
                origin: server.origin.clone(),
                addresses: vec!["127.0.0.1".parse().unwrap()],
                expires: Instant::now() + Duration::from_secs(30),
            },
        },
    );
    network.start(&json!({"kind":"request","request":{"bindingId":binding,"url":format!("{}/",server.origin),
        "method":"GET","headers":[],"body":""}}).to_string()).unwrap()
}
fn queue_completed(network: &NativeNetwork, id: u64) {
    let finished = network
        .receive
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    assert_eq!(finished.0, id);
    assert!(
        finished.1.is_ok(),
        "native transport result: {:?}",
        finished.1.as_ref().err()
    );
    network.send.send(finished).unwrap();
}
fn head(network: &mut NativeNetwork, server: &Server, binding: &str) -> String {
    let id = request(network, server, binding);
    queue_completed(network, id);
    let result = network.poll();
    assert_eq!(result.len(), 1);
    result[0].1.as_ref().unwrap()["streamId"]
        .as_str()
        .unwrap()
        .to_string()
}
fn close(network: &mut NativeNetwork, stream: &str) {
    let result: Value = serde_json::from_str(
        &network.sync(&json!({"kind":"closeStream","streamId":stream}).to_string()),
    )
    .unwrap();
    assert_eq!(result["ok"], true);
}

#[test]
fn cancellation_before_head_delivery_discards_queued_stream_and_connection() {
    let server = Server::new();
    let mut network = network(&server);
    let id = request(&mut network, &server, "first");
    queue_completed(&network, id);
    network.cancel(id);
    network.cancel(id);
    let result = network.poll();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].1.as_ref().unwrap_err(), &"runtime.cancelled");
    assert_eq!(network.open_connections, 0);
    assert!(network.streams.is_empty());
    let fresh = head(&mut network, &server, "fresh");
    close(&mut network, &fresh);
    assert_eq!(network.open_connections, 0);
}

#[test]
fn close_during_queued_pull_cannot_resurrect_stream_or_release_another_slot() {
    let server = Server::new();
    let mut network = network(&server);
    let first = head(&mut network, &server, "first");
    let second = head(&mut network, &server, "second");
    assert_eq!(network.open_connections, 2);
    let id = network
        .start(&json!({"kind":"pull","streamId":first}).to_string())
        .unwrap();
    queue_completed(&network, id);
    close(&mut network, &first);
    let result = network.poll();
    assert_eq!(result[0].1.as_ref().unwrap_err(), &"runtime.cancelled");
    assert!(!network.streams.contains_key(&first));
    assert!(network.streams.contains_key(&second));
    assert_eq!(network.open_connections, 1);
    close(&mut network, &first);
    assert_eq!(network.open_connections, 1);
    close(&mut network, &second);
    assert_eq!(network.open_connections, 0);
}

#[test]
fn one_pull_is_bounded_and_remains_admissible_at_aggregate_handle_capacity() {
    let server = Server::new();
    let mut network = network(&server);
    let stream = head(&mut network, &server, "first");
    assert!(!network.active()); // Retained idle body does not keep the Runtime alive.
    for i in 0..1023 {
        network.resolutions.insert(
            format!("retained-{i}"),
            Resolution {
                origin: server.origin.clone(),
                addresses: vec!["127.0.0.1".parse().unwrap()],
                expires: Instant::now() + Duration::from_secs(30),
            },
        );
    }
    let input = json!({"kind":"pull","streamId":stream}).to_string();
    let id = network.start(&input).unwrap();
    assert_eq!(network.start(&input), Err("provider.protocol_error"));
    queue_completed(&network, id);
    let result = network.poll();
    let value = result[0].1.as_ref().unwrap();
    assert_eq!(value["done"], false);
    assert_eq!(value["body"], "YWI=");
    assert_eq!(network.open_connections, 1);
    assert!(network.streams.contains_key(&stream));
    close(&mut network, &stream);
    assert_eq!(network.open_connections, 0);
}
