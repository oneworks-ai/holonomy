//! Host-only Process network I/O. The shared Process Provider and Kernel own
//! authority; this module owns DNS evidence, literal-address sockets and their
//! generation-scoped lifetime. It never reads the ordinary Fetch Policy.
use crate::network::is_private;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::{
    Client, Method,
    header::{HeaderName, HeaderValue},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    future::Future,
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    pin::Pin,
    sync::{
        Arc,
        mpsc::{self, Receiver, Sender},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UdpSocket},
    runtime::Runtime,
    sync::{Mutex, Semaphore},
    task::JoinHandle,
};

pub type Result<T> = std::result::Result<T, &'static str>;
const MAX_JSON: usize = 128 * 1024;
const MAX_SAFE_ID: u64 = (1u64 << 53) - 1;
const MAX_SOCKETS: usize = 32;
const MAX_LOOKUPS: usize = 32;
const MAX_JOBS: usize = 128;
const MAX_BYTES: usize = 64 * 1024;
const MAX_HTTP_PULL: usize = 16 * 1024;
const MAX_HTTP_BODY: usize = 8 * 1024 * 1024;
const MAX_QUEUED_SOCKET: usize = 256 * 1024;
const MAX_QUEUED_TOTAL: usize = 4 * 1024 * 1024;
const MAX_OPERATION: Duration = Duration::from_secs(30);
const DNS_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Endpoint {
    hostname: String,
    ports: Vec<u16>,
    transport: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessPolicy {
    access: String,
    network: ProcessNetworkPolicy,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProcessNetworkPolicy {
    access: String,
    endpoints: Vec<Endpoint>,
    max_sockets: usize,
    private_network: String,
}

#[derive(Clone)]
struct Profile {
    generation: u64,
    endpoints: Vec<Endpoint>,
    max_sockets: usize,
    allow_private: bool,
}

impl Profile {
    fn parse(value: Value, generation: u64) -> Result<Self> {
        let input: ProcessPolicy = serde_json::from_value(value).map_err(|_| "argument.invalid")?;
        let network = input.network;
        if input.access != "sandboxed"
            || network.access != "restricted"
            || network.endpoints.is_empty()
            || network.endpoints.len() > 64
            || network.max_sockets == 0
            || network.max_sockets > 128
            || !matches!(network.private_network.as_str(), "allow" | "deny")
        {
            return Err("argument.invalid");
        }
        for endpoint in &network.endpoints {
            if endpoint.hostname.is_empty()
                || endpoint.hostname.len() > 253
                || endpoint.hostname != endpoint.hostname.to_ascii_lowercase()
                || endpoint.ports.is_empty()
                || endpoint.ports.len() > 64
                || endpoint.ports.contains(&0)
                || !matches!(endpoint.transport.as_str(), "tcp" | "tls" | "udp")
            {
                return Err("argument.invalid");
            }
        }
        Ok(Self {
            generation,
            endpoints: network.endpoints,
            max_sockets: network.max_sockets.min(MAX_SOCKETS),
            allow_private: network.private_network == "allow",
        })
    }

    fn allows(&self, hostname: &str, port: u16, transport: &str) -> bool {
        self.endpoints.iter().any(|item| {
            item.hostname == hostname && item.transport == transport && item.ports.contains(&port)
        })
    }
}

#[derive(Clone)]
struct Bound {
    invocation_digest: String,
    evidence_digest: String,
}

#[derive(Clone)]
struct Resolution {
    token: String,
    generation: u64,
    environment_id: String,
    hostname: String,
    port: u16,
    transport: String,
    semantic_digest: String,
    addresses: Vec<IpAddr>,
    expires: Instant,
    expires_at_ms: u64,
    verified: bool,
    bound: Option<Bound>,
}

impl Resolution {
    fn value(&self) -> Value {
        json!({
            "resolutionToken": self.token,
            "addresses": self.addresses.iter().map(canonical_ip).collect::<Vec<_>>(),
            "expiresAtMonotonicMs": self.expires_at_ms,
            "resolverGeneration": self.generation
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReceiptResolution {
    addresses: Vec<String>,
    evidence_digest: String,
    expires_at_monotonic_ms: f64,
    resolver_generation: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Receipt {
    authorized: bool,
    generation: u64,
    invocation_binding_digest: String,
    semantic_resource_digest: String,
    resolution: ReceiptResolution,
}

enum SocketKind {
    Tcp {
        read: Arc<Mutex<tokio::net::tcp::OwnedReadHalf>>,
        write: Arc<Mutex<tokio::net::tcp::OwnedWriteHalf>>,
    },
    Udp(Arc<UdpSocket>),
    Http(Arc<Mutex<HttpBody>>),
}

struct HttpBody {
    response: reqwest::Response,
    pending: Vec<u8>,
    offset: usize,
    total: usize,
}

struct Socket {
    generation: u64,
    environment_id: String,
    kind: SocketKind,
    pending_read: bool,
    pending_write: bool,
    queued_bytes: usize,
}

enum Completion {
    Addresses(Vec<IpAddr>),
    Verified,
    Open(SocketKind, Value),
    Value(Value),
}

enum JobKind {
    Resolve {
        token: String,
        resolution: Box<Resolution>,
    },
    Verify {
        token: String,
    },
    Open {
        socket_token: String,
    },
    Other,
}

struct Job {
    generation: u64,
    environment_id: Option<String>,
    socket_token: Option<String>,
    kind: JobKind,
    lookup: bool,
    opening: bool,
    reserved_bytes: usize,
    read: bool,
    write: bool,
    deadline: Instant,
    cancelled: bool,
    task: JoinHandle<()>,
}

type Finished = (u64, Result<Completion>);
type FutureResult = Pin<Box<dyn Future<Output = Result<Completion>> + Send>>;

pub struct NativeProcessNetwork {
    epoch: Instant,
    runtime: Option<Runtime>,
    profile: Option<Profile>,
    next: u64,
    send: Sender<Finished>,
    receive: Receiver<Finished>,
    jobs: HashMap<u64, Job>,
    resolutions: HashMap<String, Resolution>,
    sockets: HashMap<String, Socket>,
    lookups: usize,
    physical_dns_slots: Arc<Semaphore>,
    openings: usize,
    queued_bytes: usize,
}

impl NativeProcessNetwork {
    pub fn new(epoch: Instant) -> Self {
        let (send, receive) = mpsc::channel();
        Self {
            epoch,
            runtime: None,
            profile: None,
            next: 0,
            send,
            receive,
            jobs: HashMap::new(),
            resolutions: HashMap::new(),
            sockets: HashMap::new(),
            lookups: 0,
            physical_dns_slots: Arc::new(Semaphore::new(MAX_LOOKUPS)),
            openings: 0,
            queued_bytes: 0,
        }
    }

    pub fn active(&self) -> bool {
        !self.jobs.is_empty()
    }

    fn next(&mut self, prefix: &str) -> Result<String> {
        self.next = self.next.checked_add(1).ok_or("provider.quota")?;
        if self.next > MAX_SAFE_ID {
            return Err("provider.quota");
        }
        Ok(format!("{prefix}-{}", self.next))
    }

    fn profile(&self, generation: u64) -> Result<&Profile> {
        self.profile
            .as_ref()
            .filter(|profile| profile.generation == generation)
            .ok_or("resource.stale")
    }

    fn close_socket(&mut self, token: &str) {
        self.sockets.remove(token);
        for (id, job) in self
            .jobs
            .iter_mut()
            .filter(|(_, job)| job.socket_token.as_deref() == Some(token))
        {
            if job.cancelled {
                continue;
            }
            job.cancelled = true;
            job.task.abort();
            self.queued_bytes = self.queued_bytes.saturating_sub(job.reserved_bytes);
            job.reserved_bytes = 0;
            let _ = self.send.send((*id, Err("runtime.cancelled")));
        }
    }

    fn close_environment(&mut self, generation: u64, environment_id: &str) {
        self.resolutions.retain(|_, value| {
            value.generation != generation || value.environment_id != environment_id
        });
        let tokens = self
            .sockets
            .iter()
            .filter(|(_, value)| {
                value.generation == generation && value.environment_id == environment_id
            })
            .map(|(token, _)| token.clone())
            .collect::<Vec<_>>();
        for token in tokens {
            self.close_socket(&token);
        }
        for (id, job) in self.jobs.iter_mut().filter(|(_, job)| {
            job.generation == generation && job.environment_id.as_deref() == Some(environment_id)
        }) {
            if job.cancelled {
                continue;
            }
            job.cancelled = true;
            job.task.abort();
            self.queued_bytes = self.queued_bytes.saturating_sub(job.reserved_bytes);
            job.reserved_bytes = 0;
            let _ = self.send.send((*id, Err("runtime.cancelled")));
        }
    }

    fn close_generation(&mut self, generation: u64) {
        if self
            .profile
            .as_ref()
            .is_none_or(|profile| profile.generation != generation)
        {
            return;
        }
        for (id, job) in &mut self.jobs {
            if job.cancelled {
                continue;
            }
            job.cancelled = true;
            job.task.abort();
            let _ = self.send.send((*id, Err("runtime.cancelled")));
        }
        self.resolutions.clear();
        self.sockets.clear();
        self.queued_bytes = 0;
        self.profile = None;
    }

    pub fn sync(&mut self, input: &str) -> String {
        let result = (|| {
            let value = parse(input)?;
            let object = object(&value)?;
            let generation = common(object)?;
            match string(object, "kind")? {
                "installProfile" => {
                    only(object, &["schemaVersion", "kind", "generation", "policy"])?;
                    if self.profile.is_some() {
                        return Err("provider.protocol_error");
                    }
                    let profile = Profile::parse(required(object, "policy")?.clone(), generation)?;
                    let runtime = tokio::runtime::Builder::new_multi_thread()
                        .worker_threads(2)
                        .max_blocking_threads(MAX_LOOKUPS)
                        .enable_all()
                        .build()
                        .map_err(|_| "provider.unavailable")?;
                    if let Some(previous) = self.runtime.replace(runtime) {
                        // A cancelled DNS caller can leave its blocking OS lookup
                        // running. Replacing the Runtime must not wait for it.
                        previous.shutdown_timeout(Duration::from_millis(100));
                    }
                    self.profile = Some(profile);
                    Ok(json!({}))
                }
                "bindResolution" => {
                    only(
                        object,
                        &[
                            "schemaVersion",
                            "kind",
                            "generation",
                            "resolutionToken",
                            "invocationBindingDigest",
                            "semanticResourceDigest",
                            "evidenceDigest",
                        ],
                    )?;
                    self.profile(generation)?;
                    let token = string(object, "resolutionToken")?;
                    let invocation = digest(object, "invocationBindingDigest")?.to_owned();
                    let semantic = digest(object, "semanticResourceDigest")?;
                    let evidence = digest(object, "evidenceDigest")?.to_owned();
                    let entry = self.resolutions.get_mut(token).ok_or("resource.stale")?;
                    if entry.generation != generation
                        || entry.semantic_digest != semantic
                        || !entry.verified
                        || entry.bound.is_some()
                        || entry.expires <= Instant::now()
                    {
                        return Err("resource.stale");
                    }
                    entry.bound = Some(Bound {
                        invocation_digest: invocation,
                        evidence_digest: evidence,
                    });
                    Ok(json!({}))
                }
                "discardResolution" => {
                    only(
                        object,
                        &["schemaVersion", "kind", "generation", "resolutionToken"],
                    )?;
                    let token = string(object, "resolutionToken")?;
                    if self
                        .resolutions
                        .get(token)
                        .is_some_and(|value| value.generation == generation)
                    {
                        self.resolutions.remove(token);
                    }
                    for (id, job) in self.jobs.iter_mut().filter(|(_, job)| {
                        job.generation == generation &&
                            matches!(&job.kind, JobKind::Verify { token: pending } if pending == token)
                    }) {
                        if job.cancelled { continue; }
                        job.cancelled = true;
                        job.task.abort();
                        let _ = self.send.send((*id, Err("runtime.cancelled")));
                    }
                    Ok(json!({}))
                }
                "close" => {
                    only(
                        object,
                        &["schemaVersion", "kind", "generation", "socketToken"],
                    )?;
                    let token = string(object, "socketToken")?;
                    if self
                        .sockets
                        .get(token)
                        .is_some_and(|value| value.generation == generation)
                    {
                        self.close_socket(token);
                    }
                    Ok(json!({}))
                }
                "closeEnvironment" => {
                    only(
                        object,
                        &["schemaVersion", "kind", "generation", "environmentId"],
                    )?;
                    let environment = string(object, "environmentId")?;
                    self.close_environment(generation, environment);
                    Ok(json!({}))
                }
                "closeGeneration" => {
                    only(object, &["schemaVersion", "kind", "generation"])?;
                    self.close_generation(generation);
                    Ok(json!({}))
                }
                _ => Err("argument.invalid"),
            }
        })();
        match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(code) => json!({"ok":false,"code":code}),
        }
        .to_string()
    }

    pub fn start(&mut self, input: &str) -> Result<u64> {
        let value = parse(input)?;
        let object = object(&value)?;
        let generation = common(object)?;
        let profile = self.profile(generation)?.clone();
        if self.jobs.len() >= MAX_JOBS {
            return Err("provider.quota");
        }
        let deadline = deadline(object, self.epoch)?;
        // An exhausted job ID must fail before any receipt consumption, socket
        // direction flag, or queued-byte reservation is changed.
        self.next = self.next.checked_add(1).ok_or("provider.quota")?;
        if self.next > MAX_SAFE_ID {
            return Err("provider.quota");
        }
        let id = self.next;
        let mut job = JobDraft::new(generation, deadline);
        let future: FutureResult = match string(object, "kind")? {
            "resolve" => {
                only(
                    object,
                    &[
                        "schemaVersion",
                        "kind",
                        "generation",
                        "environmentId",
                        "hostname",
                        "port",
                        "transport",
                        "semanticResourceDigest",
                        "deadlineMs",
                    ],
                )?;
                if self.lookups >= MAX_LOOKUPS || self.resolutions.len() >= 128 {
                    return Err("resource.handle_limit");
                }
                let environment = bounded(string(object, "environmentId")?, 256)?.to_owned();
                let hostname = bounded(string(object, "hostname")?, 253)?.to_owned();
                let port = port(object)?;
                let transport = string(object, "transport")?.to_owned();
                if !profile.allows(&hostname, port, &transport) {
                    return Err("policy.denied");
                }
                let semantic = digest(object, "semanticResourceDigest")?.to_owned();
                let token = self.next("resolution")?;
                let resolution = Resolution {
                    token: token.clone(),
                    generation,
                    environment_id: environment.clone(),
                    hostname: hostname.clone(),
                    port,
                    transport,
                    semantic_digest: semantic,
                    addresses: Vec::new(),
                    expires: Instant::now() + DNS_TTL,
                    expires_at_ms: 0,
                    verified: false,
                    bound: None,
                };
                job.kind = JobKind::Resolve {
                    token,
                    resolution: Box::new(resolution),
                };
                job.environment_id = Some(environment);
                job.lookup = true;
                let allow_private = profile.allow_private;
                let dns_slots = Arc::clone(&self.physical_dns_slots);
                Box::pin(async move {
                    Ok(Completion::Addresses(
                        resolve_addresses(hostname, port, allow_private, dns_slots).await?,
                    ))
                })
            }
            "verifyResolution" => {
                only(
                    object,
                    &[
                        "schemaVersion",
                        "kind",
                        "generation",
                        "resolutionToken",
                        "deadlineMs",
                    ],
                )?;
                if self.lookups >= MAX_LOOKUPS {
                    return Err("resource.handle_limit");
                }
                let token = string(object, "resolutionToken")?.to_owned();
                let record = self
                    .resolutions
                    .get(&token)
                    .ok_or("resource.stale")?
                    .clone();
                if record.generation != generation
                    || record.expires <= Instant::now()
                    || record.verified
                    || record.bound.is_some()
                {
                    return Err("resource.stale");
                }
                if self.jobs.values().any(|job| matches!(&job.kind, JobKind::Verify { token: pending } if pending == &token)) {
                    return Err("provider.protocol_error");
                }
                job.environment_id = Some(record.environment_id.clone());
                job.kind = JobKind::Verify { token };
                job.lookup = true;
                let allow_private = profile.allow_private;
                let dns_slots = Arc::clone(&self.physical_dns_slots);
                Box::pin(async move {
                    let current = resolve_addresses(
                        record.hostname.clone(),
                        record.port,
                        allow_private,
                        dns_slots,
                    )
                    .await?;
                    if current != record.addresses {
                        return Err("resource.invalid");
                    }
                    Ok(Completion::Verified)
                })
            }
            "openTcp" | "openUdp" | "httpRequest" => {
                let kind = string(object, "kind")?;
                let http = kind == "httpRequest";
                if http {
                    only(
                        object,
                        &[
                            "schemaVersion",
                            "kind",
                            "generation",
                            "environmentId",
                            "resolutionToken",
                            "receipt",
                            "address",
                            "url",
                            "method",
                            "headers",
                            "bodyBase64",
                            "deadlineMs",
                        ],
                    )?;
                } else {
                    only(
                        object,
                        &[
                            "schemaVersion",
                            "kind",
                            "generation",
                            "environmentId",
                            "resolutionToken",
                            "receipt",
                            "address",
                            "port",
                            "deadlineMs",
                        ],
                    )?;
                }
                if self.sockets.len() + self.openings >= profile.max_sockets {
                    return Err("provider.quota");
                }
                let environment = bounded(string(object, "environmentId")?, 256)?.to_owned();
                let token = string(object, "resolutionToken")?;
                let address: IpAddr = string(object, "address")?
                    .parse()
                    .map_err(|_| "argument.invalid")?;
                let receipt: Receipt = serde_json::from_value(required(object, "receipt")?.clone())
                    .map_err(|_| "argument.invalid")?;
                let resolution = self.resolutions.get(token).ok_or("resource.stale")?;
                let expected = resolution.transport.as_str();
                let kind_matches = if kind == "openTcp" {
                    expected == "tcp"
                } else if kind == "openUdp" {
                    expected == "udp"
                } else {
                    matches!(expected, "tcp" | "tls")
                };
                if resolution.generation != generation
                    || resolution.environment_id != environment
                    || !kind_matches
                    || !resolution.verified
                    || resolution.expires <= Instant::now()
                    || !resolution.addresses.contains(&address)
                    || !valid_receipt(resolution, &receipt)
                {
                    return Err("resource.stale");
                }
                let selected_port = if http { resolution.port } else { port(object)? };
                if selected_port != resolution.port
                    || !profile.allows(&resolution.hostname, selected_port, expected)
                {
                    return Err("policy.denied");
                }
                if http && !matches!(expected, "tcp" | "tls") {
                    return Err("policy.denied");
                }
                let http_request_input = if http {
                    Some(http_input(object, resolution)?)
                } else {
                    None
                };
                let expires = resolution.expires;
                let socket_token = self.next("socket")?;
                self.resolutions.remove(token).ok_or("resource.stale")?;
                job.kind = JobKind::Open {
                    socket_token: socket_token.clone(),
                };
                job.environment_id = Some(environment);
                job.opening = true;
                let peer = SocketAddr::new(address, selected_port);
                if let Some(request) = http_request_input {
                    Box::pin(async move {
                        if Instant::now() >= expires {
                            return Err("resource.stale");
                        }
                        let (socket, head) = http_request(peer, request).await?;
                        Ok(Completion::Open(socket, head))
                    })
                } else if kind == "openTcp" {
                    Box::pin(async move {
                        if Instant::now() >= expires {
                            return Err("resource.stale");
                        }
                        let stream = TcpStream::connect(peer).await.map_err(socket_error)?;
                        if stream.peer_addr().map_err(|_| "provider.unavailable")? != peer {
                            return Err("provider.protocol_error");
                        }
                        let (read, write) = stream.into_split();
                        Ok(Completion::Open(
                            SocketKind::Tcp {
                                read: Arc::new(Mutex::new(read)),
                                write: Arc::new(Mutex::new(write)),
                            },
                            json!({}),
                        ))
                    })
                } else {
                    Box::pin(async move {
                        if Instant::now() >= expires {
                            return Err("resource.stale");
                        }
                        let bind = if address.is_ipv4() {
                            "0.0.0.0:0"
                        } else {
                            "[::]:0"
                        };
                        let socket = UdpSocket::bind(bind).await.map_err(socket_error)?;
                        socket.connect(peer).await.map_err(socket_error)?;
                        if socket.peer_addr().map_err(|_| "provider.unavailable")? != peer {
                            return Err("provider.protocol_error");
                        }
                        Ok(Completion::Open(
                            SocketKind::Udp(Arc::new(socket)),
                            json!({}),
                        ))
                    })
                }
            }
            "readTcp" | "writeTcp" | "endTcp" | "sendUdp" | "recvUdp" | "httpPull" => {
                let kind = string(object, "kind")?;
                let token = string(object, "socketToken")?.to_owned();
                let socket = self.sockets.get_mut(&token).ok_or("resource.stale")?;
                if socket.generation != generation {
                    return Err("resource.stale");
                }
                job.environment_id = Some(socket.environment_id.clone());
                job.socket_token = Some(token);
                let is_read = matches!(kind, "readTcp" | "recvUdp" | "httpPull");
                if is_read && socket.pending_read || !is_read && socket.pending_write {
                    return Err("provider.protocol_error");
                }
                let future = match (&socket.kind, kind) {
                    (SocketKind::Tcp { read, .. }, "readTcp") => {
                        only(
                            object,
                            &[
                                "schemaVersion",
                                "kind",
                                "generation",
                                "socketToken",
                                "maxBytes",
                                "deadlineMs",
                            ],
                        )?;
                        let max = max_bytes(object, MAX_BYTES)?;
                        let read = Arc::clone(read);
                        Box::pin(async move {
                            let mut bytes = vec![0; max];
                            let len = read
                                .lock()
                                .await
                                .read(&mut bytes)
                                .await
                                .map_err(socket_error)?;
                            Ok(Completion::Value(
                                json!({"base64":STANDARD.encode(&bytes[..len]),"eof":len==0}),
                            ))
                        }) as FutureResult
                    }
                    (SocketKind::Tcp { write, .. }, "writeTcp") => {
                        only(
                            object,
                            &[
                                "schemaVersion",
                                "kind",
                                "generation",
                                "socketToken",
                                "base64",
                                "deadlineMs",
                            ],
                        )?;
                        let bytes = bytes(object, "base64", MAX_BYTES)?;
                        let write = Arc::clone(write);
                        reserve_bytes(socket, &mut self.queued_bytes, bytes.len())?;
                        job.reserved_bytes = bytes.len();
                        Box::pin(async move {
                            write
                                .lock()
                                .await
                                .write_all(&bytes)
                                .await
                                .map_err(socket_error)?;
                            Ok(Completion::Value(json!({"written":bytes.len()})))
                        })
                    }
                    (SocketKind::Tcp { write, .. }, "endTcp") => {
                        only(
                            object,
                            &[
                                "schemaVersion",
                                "kind",
                                "generation",
                                "socketToken",
                                "deadlineMs",
                            ],
                        )?;
                        let write = Arc::clone(write);
                        Box::pin(async move {
                            write.lock().await.shutdown().await.map_err(socket_error)?;
                            Ok(Completion::Value(json!({})))
                        })
                    }
                    (SocketKind::Udp(socket_udp), "sendUdp") => {
                        only(
                            object,
                            &[
                                "schemaVersion",
                                "kind",
                                "generation",
                                "socketToken",
                                "base64",
                                "deadlineMs",
                            ],
                        )?;
                        let bytes = bytes(object, "base64", 1472)?;
                        let socket_udp = Arc::clone(socket_udp);
                        reserve_bytes(socket, &mut self.queued_bytes, bytes.len())?;
                        job.reserved_bytes = bytes.len();
                        Box::pin(async move {
                            let written = socket_udp.send(&bytes).await.map_err(socket_error)?;
                            if written != bytes.len() {
                                return Err("provider.protocol_error");
                            }
                            Ok(Completion::Value(json!({"written":written})))
                        })
                    }
                    (SocketKind::Udp(socket_udp), "recvUdp") => {
                        only(
                            object,
                            &[
                                "schemaVersion",
                                "kind",
                                "generation",
                                "socketToken",
                                "maxBytes",
                                "deadlineMs",
                            ],
                        )?;
                        let max = max_bytes(object, 1472)?;
                        let socket_udp = Arc::clone(socket_udp);
                        Box::pin(async move {
                            let mut bytes = vec![0; max + 1];
                            let len = socket_udp.recv(&mut bytes).await.map_err(socket_error)?;
                            if len > max {
                                return Err("resource.byte_limit");
                            }
                            Ok(Completion::Value(
                                json!({"base64":STANDARD.encode(&bytes[..len])}),
                            ))
                        })
                    }
                    (SocketKind::Http(body), "httpPull") => {
                        only(
                            object,
                            &[
                                "schemaVersion",
                                "kind",
                                "generation",
                                "socketToken",
                                "maxBytes",
                                "deadlineMs",
                            ],
                        )?;
                        let max = max_bytes(object, MAX_HTTP_PULL)?;
                        let body = Arc::clone(body);
                        Box::pin(async move {
                            let mut body = body.lock().await;
                            if body.offset == body.pending.len() {
                                body.pending.clear();
                                body.offset = 0;
                                let Some(chunk) =
                                    body.response.chunk().await.map_err(http_error)?
                                else {
                                    return Ok(Completion::Value(json!({"base64":"","eof":true})));
                                };
                                body.total = body
                                    .total
                                    .checked_add(chunk.len())
                                    .ok_or("resource.byte_limit")?;
                                // At most 32 sockets can retain one 64 KiB chunk each;
                                // together with single pending writes this stays below
                                // the aggregate 4 MiB queue ceiling by construction.
                                if body.total > MAX_HTTP_BODY || chunk.len() > MAX_BYTES {
                                    return Err("resource.byte_limit");
                                }
                                body.pending = chunk.to_vec();
                            }
                            let end = (body.offset + max).min(body.pending.len());
                            let output = STANDARD.encode(&body.pending[body.offset..end]);
                            body.offset = end;
                            Ok(Completion::Value(json!({"base64":output,"eof":false})))
                        })
                    }
                    _ => return Err("argument.invalid"),
                };
                if is_read {
                    socket.pending_read = true;
                    job.read = true;
                } else {
                    socket.pending_write = true;
                    job.write = true;
                }
                future
            }
            _ => return Err("argument.invalid"),
        };
        let sender = self.send.clone();
        let duration = deadline.saturating_duration_since(Instant::now());
        let task = self
            .runtime
            .as_ref()
            .ok_or("provider.unavailable")?
            .spawn(async move {
                let result = tokio::time::timeout(duration, future)
                    .await
                    .unwrap_or(Err("provider.timeout"));
                let _ = sender.send((id, result));
            });
        self.lookups += usize::from(job.lookup);
        self.openings += usize::from(job.opening);
        self.jobs.insert(id, job.finish(task));
        Ok(id)
    }

    pub fn cancel(&mut self, id: u64) {
        if let Some(job) = self.jobs.get_mut(&id)
            && !job.cancelled
        {
            job.cancelled = true;
            job.task.abort();
            let _ = self.send.send((id, Err("runtime.cancelled")));
        }
    }

    pub fn poll(&mut self) -> Vec<(u64, Result<Value>)> {
        let mut output = Vec::new();
        while let Ok((id, result)) = self.receive.try_recv() {
            let Some(job) = self.jobs.remove(&id) else {
                continue;
            };
            self.lookups = self.lookups.saturating_sub(usize::from(job.lookup));
            self.openings = self.openings.saturating_sub(usize::from(job.opening));
            if let Some(token) = job.socket_token.as_deref()
                && let Some(socket) = self.sockets.get_mut(token)
            {
                socket.pending_read &= !job.read;
                socket.pending_write &= !job.write;
                socket.queued_bytes = socket.queued_bytes.saturating_sub(job.reserved_bytes);
            }
            self.queued_bytes = self.queued_bytes.saturating_sub(job.reserved_bytes);
            let result = if job.cancelled
                || self
                    .profile
                    .as_ref()
                    .is_none_or(|p| p.generation != job.generation)
            {
                Err("runtime.cancelled")
            } else if Instant::now() > job.deadline {
                Err("provider.timeout")
            } else {
                result.and_then(|completion| {
                    self.complete(
                        job.kind,
                        completion,
                        job.generation,
                        job.environment_id.as_deref(),
                    )
                })
            };
            if let Some(token) = job.socket_token.as_deref() {
                if result.is_err()
                    && matches!(
                        self.sockets.get(token).map(|s| &s.kind),
                        Some(SocketKind::Http(_))
                    )
                {
                    self.close_socket(token);
                }
                if result.as_ref().is_ok_and(|value| value["eof"] == true)
                    && matches!(
                        self.sockets.get(token).map(|s| &s.kind),
                        Some(SocketKind::Http(_))
                    )
                {
                    self.close_socket(token);
                }
            }
            output.push((id, result));
        }
        output
    }

    fn complete(
        &mut self,
        kind: JobKind,
        completion: Completion,
        generation: u64,
        environment_id: Option<&str>,
    ) -> Result<Value> {
        match (kind, completion) {
            (JobKind::Resolve { token, resolution }, Completion::Addresses(addresses)) => {
                if self.resolutions.contains_key(&token) {
                    return Err("provider.protocol_error");
                }
                let mut resolution = *resolution;
                resolution.addresses = addresses;
                resolution.expires = Instant::now() + DNS_TTL;
                resolution.expires_at_ms =
                    resolution.expires.duration_since(self.epoch).as_millis() as u64;
                let value = resolution.value();
                self.resolutions.insert(token, resolution);
                Ok(value)
            }
            (JobKind::Verify { token }, Completion::Verified) => {
                let resolution = self.resolutions.get_mut(&token).ok_or("resource.stale")?;
                if resolution.expires <= Instant::now() {
                    return Err("resource.stale");
                }
                resolution.verified = true;
                Ok(resolution.value())
            }
            (JobKind::Open { socket_token }, Completion::Open(kind, mut head)) => {
                let object = head.as_object_mut().ok_or("provider.protocol_error")?;
                object.insert("socketToken".into(), json!(socket_token));
                // Opening job carries the environment identity in its enclosing Job;
                // it is filled before insertion in poll below.
                self.sockets.insert(
                    socket_token,
                    Socket {
                        generation,
                        environment_id: environment_id.ok_or("provider.protocol_error")?.to_owned(),
                        kind,
                        pending_read: false,
                        pending_write: false,
                        queued_bytes: 0,
                    },
                );
                Ok(head)
            }
            (JobKind::Other, Completion::Value(value)) => Ok(value),
            _ => Err("provider.protocol_error"),
        }
    }
}

struct JobDraft {
    generation: u64,
    environment_id: Option<String>,
    socket_token: Option<String>,
    kind: JobKind,
    lookup: bool,
    opening: bool,
    reserved_bytes: usize,
    read: bool,
    write: bool,
    deadline: Instant,
}

impl JobDraft {
    fn new(generation: u64, deadline: Instant) -> Self {
        Self {
            generation,
            environment_id: None,
            socket_token: None,
            kind: JobKind::Other,
            lookup: false,
            opening: false,
            reserved_bytes: 0,
            read: false,
            write: false,
            deadline,
        }
    }
    fn finish(self, task: JoinHandle<()>) -> Job {
        Job {
            generation: self.generation,
            environment_id: self.environment_id,
            socket_token: self.socket_token,
            kind: self.kind,
            lookup: self.lookup,
            opening: self.opening,
            reserved_bytes: self.reserved_bytes,
            read: self.read,
            write: self.write,
            deadline: self.deadline,
            cancelled: false,
            task,
        }
    }
}

impl Drop for NativeProcessNetwork {
    fn drop(&mut self) {
        for job in self.jobs.values() {
            job.task.abort();
        }
        self.jobs.clear();
        self.resolutions.clear();
        self.sockets.clear();
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_timeout(Duration::from_millis(100));
        }
    }
}

fn parse(input: &str) -> Result<Value> {
    if input.len() > MAX_JSON {
        return Err("resource.byte_limit");
    }
    serde_json::from_str(input).map_err(|_| "argument.invalid")
}
fn object(value: &Value) -> Result<&Map<String, Value>> {
    value.as_object().ok_or("argument.invalid")
}
fn required<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a Value> {
    object.get(key).ok_or("argument.invalid")
}
fn only(object: &Map<String, Value>, keys: &[&str]) -> Result<()> {
    if object.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err("argument.invalid");
    }
    Ok(())
}
fn string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    required(object, key)?.as_str().ok_or("argument.invalid")
}
fn bounded(value: &str, maximum: usize) -> Result<&str> {
    if value.is_empty() || value.len() > maximum {
        Err("argument.invalid")
    } else {
        Ok(value)
    }
}
fn digest<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    let value = string(object, key)?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("argument.invalid");
    }
    Ok(value)
}
fn common(object: &Map<String, Value>) -> Result<u64> {
    if required(object, "schemaVersion")?.as_u64() != Some(1) {
        return Err("argument.invalid");
    }
    let generation = required(object, "generation")?
        .as_u64()
        .ok_or("argument.invalid")?;
    if generation == 0 || generation > (1u64 << 53) - 1 {
        return Err("argument.invalid");
    }
    Ok(generation)
}
fn port(object: &Map<String, Value>) -> Result<u16> {
    let value = required(object, "port")?
        .as_u64()
        .ok_or("argument.invalid")?;
    if value == 0 || value > 65535 {
        return Err("argument.invalid");
    }
    Ok(value as u16)
}
fn deadline(object: &Map<String, Value>, epoch: Instant) -> Result<Instant> {
    let value = required(object, "deadlineMs")?
        .as_f64()
        .ok_or("argument.invalid")?;
    let now = Instant::now();
    let now_ms = now.duration_since(epoch).as_secs_f64() * 1000.0;
    if !value.is_finite() || value <= now_ms {
        return Err("provider.timeout");
    }
    let remaining = Duration::from_secs_f64((value - now_ms) / 1000.0);
    Ok(now + remaining.min(MAX_OPERATION))
}
fn max_bytes(object: &Map<String, Value>, limit: usize) -> Result<usize> {
    let value = required(object, "maxBytes")?
        .as_u64()
        .ok_or("argument.invalid")? as usize;
    if value == 0 || value > limit {
        return Err("argument.invalid");
    }
    Ok(value)
}
fn bytes(object: &Map<String, Value>, key: &str, limit: usize) -> Result<Vec<u8>> {
    let encoded = string(object, key)?;
    if encoded.len() > limit.div_ceil(3) * 4 {
        return Err("resource.byte_limit");
    }
    let value = STANDARD.decode(encoded).map_err(|_| "argument.invalid")?;
    if value.len() > limit || STANDARD.encode(&value) != encoded {
        return Err("argument.invalid");
    }
    Ok(value)
}
fn reserve_bytes(socket: &mut Socket, total: &mut usize, size: usize) -> Result<()> {
    if socket.queued_bytes.saturating_add(size) > MAX_QUEUED_SOCKET
        || total.saturating_add(size) > MAX_QUEUED_TOTAL
    {
        return Err("resource.byte_limit");
    }
    socket.queued_bytes += size;
    *total += size;
    Ok(())
}
async fn physical_dns_lookup<F>(slots: Arc<Semaphore>, lookup: F) -> Result<Vec<IpAddr>>
where
    F: FnOnce() -> std::io::Result<Vec<IpAddr>> + Send + 'static,
{
    let permit = slots
        .acquire_owned()
        .await
        .map_err(|_| "provider.unavailable")?;
    // The permit moves into the blocking OS call. Aborting the async caller
    // fences its result immediately but cannot release a still-running lookup.
    tokio::task::spawn_blocking(move || {
        let _physical_reservation = permit;
        lookup().map_err(|_| "provider.unavailable")
    })
    .await
    .map_err(|_| "provider.unavailable")?
}

fn canonical_ip(address: &IpAddr) -> String {
    match address {
        IpAddr::V6(value) if value.to_ipv4_mapped().is_some() => {
            let groups = value.segments();
            format!("::ffff:{:x}:{:x}", groups[6], groups[7])
        }
        _ => address.to_string(),
    }
}

fn canonical_addresses(mut addresses: Vec<IpAddr>, allow_private: bool) -> Result<Vec<IpAddr>> {
    if addresses.is_empty() || addresses.len() > 64 {
        return Err("provider.unavailable");
    }
    addresses.sort_by_cached_key(canonical_ip);
    addresses.dedup();
    if !allow_private && addresses.iter().any(|address| is_private(*address)) {
        return Err("policy.denied");
    }
    Ok(addresses)
}

async fn resolve_addresses(
    hostname: String,
    port: u16,
    allow_private: bool,
    slots: Arc<Semaphore>,
) -> Result<Vec<IpAddr>> {
    let addresses = if let Ok(address) = hostname.parse::<IpAddr>() {
        vec![address]
    } else {
        physical_dns_lookup(slots, move || {
            Ok((hostname.as_str(), port)
                .to_socket_addrs()?
                .take(65)
                .map(|address| address.ip())
                .collect::<Vec<_>>())
        })
        .await?
    };
    canonical_addresses(addresses, allow_private)
}
fn valid_receipt(resolution: &Resolution, receipt: &Receipt) -> bool {
    let Some(bound) = resolution.bound.as_ref() else {
        return false;
    };
    let expected_expiry = resolution.expires_at_ms as f64;
    receipt.authorized
        && receipt.generation == resolution.generation
        && receipt.invocation_binding_digest == bound.invocation_digest
        && receipt.semantic_resource_digest == resolution.semantic_digest
        && receipt.resolution.evidence_digest == bound.evidence_digest
        && receipt.resolution.resolver_generation == resolution.generation
        && receipt.resolution.expires_at_monotonic_ms == expected_expiry
        && receipt.resolution.addresses
            == resolution
                .addresses
                .iter()
                .map(canonical_ip)
                .collect::<Vec<_>>()
}
fn socket_error(error: std::io::Error) -> &'static str {
    if error.kind() == std::io::ErrorKind::ConnectionRefused {
        "provider.connection_refused"
    } else if error.kind() == std::io::ErrorKind::TimedOut {
        "provider.timeout"
    } else {
        "provider.unavailable"
    }
}
fn http_error(error: reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "provider.timeout"
    } else if error.is_connect() {
        "provider.connection_refused"
    } else {
        "provider.unavailable"
    }
}
struct HttpRequest {
    hostname: String,
    url: url::Url,
    method: Method,
    headers: Vec<(HeaderName, HeaderValue)>,
    body: Vec<u8>,
}
fn http_input(object: &Map<String, Value>, resolution: &Resolution) -> Result<HttpRequest> {
    let source = bounded(string(object, "url")?, 2048)?;
    let url = url::Url::parse(source).map_err(|_| "argument.invalid")?;
    let scheme = if resolution.transport == "tls" {
        "https"
    } else {
        "http"
    };
    if url.scheme() != scheme
        || url.host_str() != Some(resolution.hostname.as_str())
        || url.port_or_known_default() != Some(resolution.port)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("policy.denied");
    }
    let method =
        Method::from_bytes(string(object, "method")?.as_bytes()).map_err(|_| "argument.invalid")?;
    if method == Method::CONNECT || method == Method::TRACE {
        return Err("argument.invalid");
    }
    let headers = required(object, "headers")?
        .as_array()
        .ok_or("argument.invalid")?;
    if headers.len() > 64 {
        return Err("resource.byte_limit");
    }
    let mut size = 0;
    let mut selected = Vec::new();
    for entry in headers {
        let pair = entry.as_array().ok_or("argument.invalid")?;
        if pair.len() != 2 {
            return Err("argument.invalid");
        }
        let name = pair[0].as_str().ok_or("argument.invalid")?;
        let value = pair[1].as_str().ok_or("argument.invalid")?;
        size += name.len() + value.len() + 4;
        if size > 16 * 1024 {
            return Err("resource.byte_limit");
        }
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "host"
                | "connection"
                | "content-length"
                | "transfer-encoding"
                | "proxy-authorization"
                | "proxy-connection"
        ) {
            return Err("argument.invalid");
        }
        selected.push((
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| "argument.invalid")?,
            HeaderValue::from_str(value).map_err(|_| "argument.invalid")?,
        ));
    }
    let body = bytes(object, "bodyBase64", 32 * 1024)?;
    Ok(HttpRequest {
        hostname: resolution.hostname.clone(),
        url,
        method,
        headers: selected,
        body,
    })
}
async fn http_request(peer: SocketAddr, request: HttpRequest) -> Result<(SocketKind, Value)> {
    let mut builder = Client::builder()
        .http1_only()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(0)
        .referer(false)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd();
    if request.hostname.parse::<IpAddr>().is_err() {
        builder = builder.resolve_to_addrs(&request.hostname, &[peer]);
    }
    let client = builder.build().map_err(http_error)?;
    let mut call = client.request(request.method, request.url.clone());
    for (name, value) in request.headers {
        call = call.header(name, value);
    }
    let response = call.body(request.body).send().await.map_err(http_error)?;
    if response.remote_addr().is_none_or(|address| address != peer) {
        return Err("provider.protocol_error");
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_HTTP_BODY as u64)
    {
        return Err("resource.byte_limit");
    }
    let status = response.status();
    let mut headers = Vec::new();
    let mut size = 0;
    for (name, value) in response.headers() {
        let value = value.to_str().map_err(|_| "provider.protocol_error")?;
        size += name.as_str().len() + value.len() + 4;
        if headers.len() >= 64 || size > 16 * 1024 {
            return Err("resource.byte_limit");
        }
        headers.push((name.as_str().to_owned(), value.to_owned()));
    }
    let head = json!({"status":status.as_u16(),"statusText":status.canonical_reason().unwrap_or(""),
        "headers":headers,"url":request.url.to_string()});
    Ok((
        SocketKind::Http(Arc::new(Mutex::new(HttpBody {
            response,
            pending: Vec::new(),
            offset: 0,
            total: 0,
        }))),
        head,
    ))
}

#[cfg(test)]
#[path = "process_network/tests.rs"]
mod tests;
