//! Disposable, profile-owned V8 execution. Guest/authorization isolates never
//! run diagnostic module code and never receive a JS handle from this module.
mod event;
mod helper;
mod vm;
mod wire;

use crate::plugin_schema::transport::{self, PoolKind};
use holonomy_desktop_host::{NativeObserverSink, ObserverOutputRecord, ObserverOutputStatus};
use std::{
    collections::HashMap,
    fs::File,
    io::{ErrorKind, Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, AtomicU32, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    time::{Duration, Instant},
};

const ARGUMENT: &str = "__observer_executor_v1";
const RESIDENT_LIMIT: u64 = 256 * 1024 * 1024;
const INIT_TIMEOUT: Duration = Duration::from_millis(2_000);
const MAX_RESTARTS: u8 = 2;
const STARTING: u8 = 0;
const READY: u8 = 1;
const FAILED: u8 = 2;
const CLOSED: u8 = 3;

pub(crate) struct ObserverExecutorSpec {
    pub profile_id: String,
    pub plan: String,
    pub bundle_sha256: String,
    pub export_name: String,
    pub config: serde_json::Value,
    pub callback_timeout_ms: u64,
    pub max_queued_events: usize,
    pub sink: NativeObserverSink,
}

struct Profile {
    send: SyncSender<String>,
    status: Arc<AtomicU8>,
    epoch: Arc<AtomicU32>,
    cancelled: Arc<AtomicBool>,
    sink: NativeObserverSink,
}

pub(crate) struct ObserverExecutor {
    profiles: HashMap<String, Profile>,
    closed: bool,
}

impl ObserverExecutor {
    pub fn new() -> Self {
        Self {
            profiles: HashMap::new(),
            closed: false,
        }
    }

    pub fn start(&mut self, spec: ObserverExecutorSpec) -> Result<(), &'static str> {
        if self.closed
            || self.profiles.len() >= 4
            || self.profiles.contains_key(&spec.profile_id)
            || spec.profile_id.is_empty()
            || spec.profile_id.len() > 64
            || !spec
                .profile_id
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            || !spec.profile_id.bytes().enumerate().all(|(index, b)| {
                b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || (b == b'-' && index > 0)
            })
            || !(1..=1_000).contains(&spec.callback_timeout_ms)
            || !(1..=256).contains(&spec.max_queued_events)
            || spec.config.to_string().len() > 65_536
            || spec.export_name.len() > 256
            || !spec
                .export_name
                .as_bytes()
                .first()
                .is_some_and(|b| b.is_ascii_alphabetic() || matches!(b, b'_' | b'$'))
            || !spec
                .export_name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'$'))
        {
            return Err("Invalid observer executor specification");
        }
        let id = spec.profile_id.clone();
        let (send, receive) = mpsc::sync_channel(spec.max_queued_events);
        let status = Arc::new(AtomicU8::new(STARTING));
        let epoch = Arc::new(AtomicU32::new(1));
        let cancelled = Arc::new(AtomicBool::new(false));
        let profile = Profile {
            send,
            status: status.clone(),
            epoch: epoch.clone(),
            cancelled: cancelled.clone(),
            sink: spec.sink.clone(),
        };
        std::thread::Builder::new()
            .name("observer-executor".into())
            .spawn(move || run_profile(spec, receive, status, epoch, cancelled))
            .map_err(|_| "Observer executor thread unavailable")?;
        self.profiles.insert(id, profile);
        Ok(())
    }

    pub fn status(&self, profile_id: &str) -> &'static str {
        match self
            .profiles
            .get(profile_id)
            .map(|profile| profile.status.load(Ordering::Acquire))
        {
            Some(STARTING) => "starting",
            Some(READY) => "ready",
            Some(FAILED) => "failed",
            _ => "closed",
        }
    }

    pub fn try_publish(&self, profile_id: &str, encoded_event: &str) -> bool {
        let Some(profile) = self.profiles.get(profile_id) else {
            return false;
        };
        if self.closed
            || profile.status.load(Ordering::Acquire) == FAILED
            || profile.status.load(Ordering::Acquire) == CLOSED
        {
            return false;
        }
        if event::validate(encoded_event).is_none() {
            return false;
        }
        match profile.send.try_send(encoded_event.to_owned()) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                let _ = profile.sink.try_record(ObserverOutputRecord {
                    epoch: profile.epoch.load(Ordering::Acquire),
                    status: ObserverOutputStatus::QueueDropped,
                    event: None,
                    dropped: 1,
                });
                false
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    }

    pub fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        for profile in self.profiles.values() {
            profile.cancelled.store(true, Ordering::Release);
            profile.status.store(CLOSED, Ordering::Release);
            profile.sink.close();
        }
    }
}

impl Default for ObserverExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ObserverExecutor {
    fn drop(&mut self) {
        self.close();
    }
}

fn run_profile(
    spec: ObserverExecutorSpec,
    receive: Receiver<String>,
    status: Arc<AtomicU8>,
    epoch_shared: Arc<AtomicU32>,
    cancelled: Arc<AtomicBool>,
) {
    let mut sequence = 0_u64;
    let mut restarts = 0_u8;
    let mut epoch = 1_u32;
    loop {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        status.store(STARTING, Ordering::Release);
        epoch_shared.store(epoch, Ordering::Release);
        let nonce = match random_nonce() {
            Some(nonce) => nonce,
            None => break,
        };
        let result = Connection::start(&spec, epoch, nonce, &cancelled);
        match result {
            Ok(mut connection) => {
                status.store(READY, Ordering::Release);
                let mut must_restart = false;
                loop {
                    if cancelled.load(Ordering::Acquire) {
                        break;
                    }
                    let encoded_event = match receive.recv_timeout(Duration::from_millis(5)) {
                        Ok(value) => value,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if connection.dead() {
                                must_restart = true;
                                break;
                            }
                            continue;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    };
                    let Some(source_event) = event::validate(&encoded_event) else {
                        continue;
                    };
                    sequence = match sequence.checked_add(1) {
                        Some(value) => value,
                        None => {
                            must_restart = true;
                            break;
                        }
                    };
                    let request = wire::CallRequest {
                        epoch,
                        sequence,
                        nonce,
                        event: encoded_event,
                    };
                    let mut started = false;
                    let result =
                        connection.call(&request, spec.callback_timeout_ms, &cancelled, || {
                            started = true;
                            let _ = spec.sink.try_record(ObserverOutputRecord {
                                epoch,
                                status: ObserverOutputStatus::CallbackStarted,
                                event: Some(source_event.clone()),
                                dropped: 0,
                            });
                        });
                    match result {
                        Ok((false, true)) => {
                            let _ = spec.sink.try_record(ObserverOutputRecord {
                                epoch,
                                status: ObserverOutputStatus::Event,
                                event: Some(source_event),
                                dropped: 0,
                            });
                        }
                        Ok((true, _)) => {
                            let _ = spec.sink.try_record(ObserverOutputRecord {
                                epoch,
                                status: ObserverOutputStatus::CallbackFailed,
                                event: Some(source_event),
                                dropped: 0,
                            });
                        }
                        Ok((false, false)) => {}
                        Err(Failure::Timeout) => {
                            let _ = spec.sink.try_record(ObserverOutputRecord {
                                epoch,
                                status: ObserverOutputStatus::CallbackTimeout,
                                event: started.then_some(source_event),
                                dropped: 0,
                            });
                            must_restart = true;
                            break;
                        }
                        Err(Failure::Transport) => {
                            let _ = spec.sink.try_record(ObserverOutputRecord {
                                epoch,
                                status: ObserverOutputStatus::CallbackFailed,
                                event: started.then_some(source_event),
                                dropped: 0,
                            });
                            must_restart = true;
                            break;
                        }
                    }
                }
                drop(connection);
                if !must_restart {
                    break;
                }
            }
            Err(_) => {
                let _ = spec.sink.try_record(ObserverOutputRecord {
                    epoch,
                    status: ObserverOutputStatus::InitializationFailed,
                    event: None,
                    dropped: 0,
                });
            }
        }
        if restarts >= MAX_RESTARTS {
            break;
        }
        restarts += 1;
        epoch += 1;
    }
    if !cancelled.load(Ordering::Acquire) {
        status.store(FAILED, Ordering::Release);
        eprintln!("Native observer profile disabled");
        let _ = spec.sink.try_record(ObserverOutputRecord {
            epoch,
            status: ObserverOutputStatus::ProfileDisabled,
            event: None,
            dropped: 0,
        });
    }
    spec.sink.close();
}

fn random_nonce() -> Option<[u8; 16]> {
    let mut bytes = [0; 16];
    File::open("/dev/urandom")
        .ok()?
        .read_exact(&mut bytes)
        .ok()?;
    Some(bytes)
}

#[derive(Debug)]
enum Failure {
    Timeout,
    Transport,
}

struct Connection {
    socket: UnixStream,
    helper: transport::Helper,
    epoch: u32,
    nonce: [u8; 16],
}
impl Connection {
    fn start(
        spec: &ObserverExecutorSpec,
        epoch: u32,
        nonce: [u8; 16],
        cancelled: &AtomicBool,
    ) -> Result<Self, Failure> {
        let executable = std::env::current_exe().map_err(|_| Failure::Transport)?;
        let (socket, helper) =
            transport::spawn_duplex(&executable, &[ARGUMENT], PoolKind::Observer)
                .map_err(|_| Failure::Transport)?;
        let mut connection = Self {
            socket,
            helper,
            epoch,
            nonce,
        };
        let request = wire::InitRequest {
            profile_id: spec.profile_id.clone(),
            plan: spec.plan.clone(),
            bundle_sha256: spec.bundle_sha256.clone(),
            export_name: spec.export_name.clone(),
            config: spec.config.clone(),
            epoch,
            nonce,
        };
        let payload = serde_json::to_vec(&request).map_err(|_| Failure::Transport)?;
        let frame =
            wire::frame(wire::INIT, &payload, wire::MAX_INIT_BYTES).ok_or(Failure::Transport)?;
        let deadline = Instant::now() + INIT_TIMEOUT;
        connection.write(&frame, deadline, cancelled)?;
        let response = connection.read(deadline, cancelled)?;
        if response.kind != wire::READY
            || response.epoch != epoch
            || response.nonce != nonce
            || response.sequence != 0
            || response.failed
            || response.published
        {
            return Err(Failure::Transport);
        }
        Ok(connection)
    }

    fn call(
        &mut self,
        request: &wire::CallRequest,
        timeout_ms: u64,
        cancelled: &AtomicBool,
        on_started: impl FnOnce(),
    ) -> Result<(bool, bool), Failure> {
        let payload = serde_json::to_vec(request).map_err(|_| Failure::Transport)?;
        let frame =
            wire::frame(wire::CALL, &payload, wire::MAX_CALL_BYTES).ok_or(Failure::Transport)?;
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        self.write(&frame, deadline, cancelled)?;
        let response = self.read(deadline, cancelled)?;
        if response.kind != wire::STARTED
            || response.epoch != self.epoch
            || response.sequence != request.sequence
            || response.nonce != self.nonce
            || response.failed
            || response.published
        {
            return Err(Failure::Transport);
        }
        on_started();
        let response = self.read(deadline, cancelled)?;
        if response.kind != wire::COMPLETED
            || response.epoch != self.epoch
            || response.sequence != request.sequence
            || response.nonce != self.nonce
            || (response.failed && response.published)
        {
            return Err(Failure::Transport);
        }
        Ok((response.failed, response.published))
    }

    fn write(
        &mut self,
        bytes: &[u8],
        deadline: Instant,
        cancelled: &AtomicBool,
    ) -> Result<(), Failure> {
        let mut sent = 0;
        while sent < bytes.len() {
            self.check(deadline, cancelled)?;
            match self
                .socket
                .write(&bytes[sent..bytes.len().min(sent + 65_536)])
            {
                Ok(0) => return Err(Failure::Transport),
                Ok(n) => sent += n,
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) =>
                {
                    std::thread::sleep(Duration::from_millis(2))
                }
                Err(_) => return Err(Failure::Transport),
            }
        }
        Ok(())
    }

    fn read(
        &mut self,
        deadline: Instant,
        cancelled: &AtomicBool,
    ) -> Result<wire::Response, Failure> {
        let mut bytes = [0; wire::RESPONSE_BYTES];
        let mut received = 0;
        while received < bytes.len() {
            self.check(deadline, cancelled)?;
            match self.socket.read(&mut bytes[received..]) {
                Ok(0) => return Err(Failure::Transport),
                Ok(n) => received += n,
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) =>
                {
                    std::thread::sleep(Duration::from_millis(2))
                }
                Err(_) => return Err(Failure::Transport),
            }
        }
        if Instant::now() >= deadline {
            return Err(Failure::Timeout);
        }
        wire::Response::decode(bytes).ok_or(Failure::Transport)
    }

    fn check(&mut self, deadline: Instant, cancelled: &AtomicBool) -> Result<(), Failure> {
        if cancelled.load(Ordering::Acquire) {
            return Err(Failure::Transport);
        }
        if Instant::now() >= deadline {
            return Err(Failure::Timeout);
        }
        if self.dead() {
            return Err(Failure::Transport);
        }
        Ok(())
    }

    fn dead(&mut self) -> bool {
        self.helper.try_wait().ok().flatten().is_some()
            || self
                .helper
                .id()
                .and_then(transport::resident_bytes)
                .is_some_and(|bytes| bytes > RESIDENT_LIMIT)
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

/// The CLI calls this before ordinary Runtime construction.
#[doc(hidden)]
pub fn observer_executor_helper_entry() -> ! {
    helper::entry()
}
