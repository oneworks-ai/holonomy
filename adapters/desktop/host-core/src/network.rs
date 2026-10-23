//! Async transport tasks; Policy is compiled by the shared Host Context.
mod policy;
#[cfg(test)]
#[path = "network/tests.rs"]
mod tests;
mod transport;
use policy::Policy;
pub(crate) use policy::is_private;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::mpsc::{self, Receiver, Sender},
    time::{Duration, Instant},
};
pub type Result<T> = std::result::Result<T, &'static str>;
#[derive(Clone)]
struct Resolution {
    origin: String,
    addresses: Vec<IpAddr>,
    expires: Instant,
}
struct Binding {
    resolution: Resolution,
    used: bool,
}
enum Completion {
    Resolution(Resolution),
    Response(transport::ResponseHead),
    Pull(transport::PullResult),
}
type Finished = (u64, Result<Completion>);
enum JobKind {
    Resolution,
    Request,
    Pull { stream_id: String },
}
struct Job {
    kind: JobKind,
    task: tokio::task::JoinHandle<()>,
    cancelled: bool,
}
pub struct NativeNetwork {
    runtime: Option<tokio::runtime::Runtime>,
    policy: Option<Policy>,
    epoch: Instant,
    next: u64,
    send: Sender<Finished>,
    receive: Receiver<Finished>,
    jobs: HashMap<u64, Job>,
    open_connections: usize,
    resolutions: HashMap<String, Resolution>,
    bindings: HashMap<String, Binding>,
    streams: HashMap<String, transport::ResponseStream>,
    stream_jobs: HashMap<String, u64>,
}
impl NativeNetwork {
    pub fn new(epoch: Instant) -> Self {
        let (send, receive) = mpsc::channel();
        Self {
            runtime: None,
            policy: None,
            epoch,
            next: 0,
            send,
            receive,
            jobs: HashMap::new(),
            open_connections: 0,
            resolutions: HashMap::new(),
            bindings: HashMap::new(),
            streams: HashMap::new(),
            stream_jobs: HashMap::new(),
        }
    }
    pub fn active(&self) -> bool {
        !self.jobs.is_empty()
    }
    pub fn sync(&mut self, input: &str) -> String {
        let result = (|| {
            if input.len() > 1024 * 1024 {
                return Err("argument.invalid");
            }
            let input: Value = serde_json::from_str(input).map_err(|_| "argument.invalid")?;
            match input["kind"].as_str() {
                Some("install") => {
                    if self.policy.is_some() {
                        return Err("provider.protocol_error");
                    }
                    if input["policy"]["access"] == "none" {
                        return Ok(json!({}));
                    }
                    let mut policy: Policy = serde_json::from_value(input["policy"].clone())
                        .map_err(|_| "argument.invalid")?;
                    if let Some(roots) = input["tlsRoots"].as_array() {
                        if roots.len() > 8 {
                            return Err("argument.invalid");
                        }
                        for root in roots {
                            let pem = root.as_str().ok_or("argument.invalid")?;
                            if pem.len() > 65536 {
                                return Err("argument.invalid");
                            }
                            policy.tls_roots.push(
                                reqwest::Certificate::from_pem(pem.as_bytes())
                                    .map_err(|_| "argument.invalid")?,
                            );
                        }
                    }
                    policy.validate()?;
                    if policy.access == "restricted" {
                        self.runtime = Some(
                            tokio::runtime::Builder::new_multi_thread()
                                .worker_threads(2)
                                .enable_all()
                                .build()
                                .map_err(|_| "provider.unavailable")?,
                        );
                    }
                    self.policy = Some(policy);
                    Ok(json!({}))
                }
                Some("bind") => {
                    let id = input["bindingId"].as_str().ok_or("argument.invalid")?;
                    if id.len() > 128
                        || self.bindings.contains_key(id)
                        || self.bindings.len() >= 1024
                    {
                        return Err("resource.handle_limit");
                    }
                    let resolution = self
                        .resolutions
                        .remove(input["resolutionId"].as_str().ok_or("argument.invalid")?)
                        .ok_or("resource.stale")?;
                    if resolution.expires <= Instant::now() {
                        return Err("resource.stale");
                    }
                    self.bindings.insert(
                        id.into(),
                        Binding {
                            resolution,
                            used: false,
                        },
                    );
                    Ok(json!({}))
                }
                Some("close") => {
                    if let Some(id) = input["bindingId"].as_str() {
                        self.bindings.remove(id);
                    }
                    Ok(json!({}))
                }
                Some("closeStream") => {
                    let id = input["streamId"].as_str().ok_or("argument.invalid")?;
                    if self.streams.remove(id).is_some() {
                        self.release_connection();
                    } else if let Some(job_id) = self.stream_jobs.get(id).copied() {
                        self.cancel(job_id);
                    }
                    Ok(json!({}))
                }
                Some("discardResolution") => {
                    if let Some(id) = input["resolutionId"].as_str() {
                        self.resolutions.remove(id);
                    }
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
        let input: Value = serde_json::from_str(input).map_err(|_| "argument.invalid")?;
        let policy = self
            .policy
            .as_ref()
            .filter(|p| p.access == "restricted")
            .ok_or("policy.denied")?
            .clone();
        if input.to_string().len() > 12 * 1024 * 1024 {
            return Err("provider.quota");
        }
        self.resolutions.retain(|_, r| r.expires > Instant::now());
        let operation = input["kind"].as_str();
        if operation != Some("pull")
            && self.resolutions.len() + self.jobs.len() + self.streams.len() >= 1024
        {
            return Err("resource.handle_limit");
        }
        self.next = self.next.checked_add(1).ok_or("provider.quota")?;
        let id = self.next;
        let send = self.send.clone();
        let (kind, future): (
            JobKind,
            std::pin::Pin<Box<dyn std::future::Future<Output = Result<Completion>> + Send>>,
        ) = match operation {
            Some("resolve") => {
                let origin = input["origin"]
                    .as_str()
                    .ok_or("argument.invalid")?
                    .to_string();
                let url = policy.check(&origin)?;
                let allow = policy.allow_private_network && input["allowPrivateNetwork"] == true;
                (
                    JobKind::Resolution,
                    Box::pin(async move {
                        let mut addresses = match url.host().ok_or("argument.invalid")? {
                            url::Host::Ipv4(ip) => vec![IpAddr::V4(ip)],
                            url::Host::Ipv6(ip) => vec![IpAddr::V6(ip)],
                            url::Host::Domain(host) => tokio::net::lookup_host((
                                host,
                                url.port_or_known_default().unwrap(),
                            ))
                            .await
                            .map_err(|_| "provider.unavailable")?
                            .take(65)
                            .map(|a| a.ip())
                            .collect(),
                        };
                        if addresses.is_empty() || addresses.len() > 64 {
                            return Err("provider.unavailable");
                        }
                        addresses.sort();
                        addresses.dedup();
                        if !allow && addresses.iter().any(|a| is_private(*a)) {
                            return Err("policy.denied");
                        }
                        Ok(Completion::Resolution(Resolution {
                            origin,
                            addresses,
                            expires: Instant::now() + Duration::from_secs(30),
                        }))
                    }),
                )
            }
            Some("request") => {
                if self.open_connections >= policy.limits.max_concurrent_connections {
                    return Err("provider.quota");
                }
                let request: transport::Request = serde_json::from_value(input["request"].clone())
                    .map_err(|_| "argument.invalid")?;
                let binding = self
                    .bindings
                    .get_mut(&request.binding_id)
                    .ok_or("resource.stale")?;
                if binding.used || binding.resolution.expires <= Instant::now() {
                    return Err("resource.stale");
                }
                binding.used = true;
                let resolution = binding.resolution.clone();
                let selected_policy = policy.clone();
                let stream_id = format!("body-{id}");
                self.open_connections += 1;
                (
                    JobKind::Request,
                    Box::pin(async move {
                        transport::request(selected_policy, resolution, request, stream_id)
                            .await
                            .map(Completion::Response)
                    }),
                )
            }
            Some("pull") => {
                let stream_id = input["streamId"]
                    .as_str()
                    .filter(|value| !value.is_empty() && value.len() <= 128)
                    .ok_or("argument.invalid")?
                    .to_string();
                if self.stream_jobs.contains_key(&stream_id) {
                    return Err("provider.protocol_error");
                }
                let stream = self.streams.remove(&stream_id).ok_or("resource.stale")?;
                self.stream_jobs.insert(stream_id.clone(), id);
                (
                    JobKind::Pull {
                        stream_id: stream_id.clone(),
                    },
                    Box::pin(async move { stream.pull().await.map(Completion::Pull) }),
                )
            }
            _ => return Err("argument.invalid"),
        };
        let task = self
            .runtime
            .as_ref()
            .ok_or("provider.unavailable")?
            .spawn(async move {
                let result = tokio::time::timeout(
                    Duration::from_millis(policy.limits.socket_timeout_ms),
                    future,
                )
                .await
                .unwrap_or(Err("provider.timeout"));
                let _ = send.send((id, result));
            });
        self.jobs.insert(
            id,
            Job {
                kind,
                task,
                cancelled: false,
            },
        );
        Ok(id)
    }
    pub fn cancel(&mut self, id: u64) {
        if let Some(job) = self.jobs.get_mut(&id)
            && !job.cancelled
        {
            // A task may already have queued a successful head/pull. Fence it
            // here so poll cannot resurrect a stream closed before delivery.
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
            let result = if job.cancelled {
                Err("runtime.cancelled")
            } else {
                result
            };
            let mut keep_connection = false;
            if let JobKind::Pull { stream_id } = &job.kind
                && self.stream_jobs.get(stream_id) == Some(&id)
            {
                self.stream_jobs.remove(stream_id);
            }
            let result=result.map(|value|match value{
                Completion::Response(head)=>{
                    if let Some(stream) = head.stream {
                        let stream_id = head.value["streamId"].as_str().unwrap().to_string();
                        self.streams.insert(stream_id, stream);
                        keep_connection = true;
                    }
                    head.value
                },
                Completion::Pull(pull)=>{
                    if let Some(stream) = pull.stream {
                        let JobKind::Pull { stream_id } = &job.kind else { unreachable!() };
                        self.streams.insert(stream_id.clone(), stream);
                        keep_connection = true;
                    }
                    pull.value
                },
                Completion::Resolution(resolution)=>{
                    let token=format!("dns-{id}");let value=json!({"resolutionId":token,"addresses":resolution.addresses.iter().map(ToString::to_string).collect::<Vec<_>>(),"expiresAtMonotonicMs":resolution.expires.duration_since(self.epoch).as_secs_f64()*1000.0,"resolverGeneration":1});
                    self.resolutions.insert(token,resolution);value
                }
            });
            if matches!(job.kind, JobKind::Request | JobKind::Pull { .. }) && !keep_connection {
                self.release_connection();
            }
            output.push((id, result));
        }
        output
    }
    fn release_connection(&mut self) {
        self.open_connections = self.open_connections.saturating_sub(1);
    }
}
impl Drop for NativeNetwork {
    fn drop(&mut self) {
        for job in self.jobs.values() {
            job.task.abort();
        }
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_timeout(Duration::from_millis(100));
        }
    }
}
