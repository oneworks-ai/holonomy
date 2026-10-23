//! Host-worker-only v86 control. No command is registered in the Guest method
//! table or the NativePort Provider map. Installation paths are trusted Host
//! inputs; the caller must never forward Guest-authored values here.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use holonomy_desktop_host::v86::{
    ArtifactSpec, MAX_ARTIFACT_BYTES, MAX_SERIAL_WRITE_BYTES, MAX_TOTAL_ARTIFACT_BYTES,
    NativeVmPort, VerifiedArtifacts, VmEngine, VmError, VmStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender, TrySendError},
    },
    thread,
    time::{Duration, Instant},
};

pub(super) const MAX_COMMAND_BYTES: usize = 128 * 1024;
pub(super) const MAX_RESULT_BYTES: usize = 128 * 1024;
const MAX_EVENTS: usize = 256;
const MAX_EVENT_DRAIN: usize = 32;
const VM_CHANNEL_CAPACITY: usize = 2;
const VM_WAIT_SLICE: Duration = Duration::from_millis(5);
const VM_COMMAND_DEADLINE: Duration = Duration::from_secs(30);
const VM_TICK_DEADLINE: Duration = Duration::from_secs(5);
const VM_SHUTDOWN_DEADLINE: Duration = Duration::from_millis(500);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactInput {
    sha256: String,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Install {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        root: String,
        bios: ArtifactInput,
        kernel: ArtifactInput,
        initrd: ArtifactInput,
        #[serde(rename = "wasmSha256")]
        wasm_sha256: String,
    },
    Open {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        id: String,
        generation: u64,
        #[serde(rename = "memoryBytes")]
        memory_bytes: u64,
        #[serde(rename = "networkEnabled", default)]
        network_enabled: bool,
    },
    Start {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        id: String,
        generation: u64,
    },
    SerialWrite {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        id: String,
        generation: u64,
        uart: u8,
        base64: String,
    },
    Drain {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        id: String,
        generation: u64,
        #[serde(rename = "maxBytes")]
        max_bytes: usize,
    },
    Poll {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        id: String,
        generation: u64,
    },
    DrainEvents {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        limit: usize,
    },
    NetworkDrain {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        id: String,
        generation: u64,
        limit: usize,
    },
    NetworkDeliver {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        id: String,
        generation: u64,
        delivery: serde_json::Value,
    },
    Close {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        id: String,
        generation: u64,
    },
}

impl Request {
    fn version(&self) -> u32 {
        match self {
            Self::Install { schema_version, .. }
            | Self::Open { schema_version, .. }
            | Self::Start { schema_version, .. }
            | Self::SerialWrite { schema_version, .. }
            | Self::Drain { schema_version, .. }
            | Self::Poll { schema_version, .. }
            | Self::DrainEvents { schema_version, .. }
            | Self::NetworkDrain { schema_version, .. }
            | Self::NetworkDeliver { schema_version, .. }
            | Self::Close { schema_version, .. } => *schema_version,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    sequence: u64,
    id: String,
    generation: u64,
    kind: &'static str,
}

fn status_name(status: VmStatus) -> &'static str {
    match status {
        VmStatus::Open => "open",
        VmStatus::Running => "running",
        VmStatus::Stopped => "stopped",
        VmStatus::Failed => "failed",
    }
}

fn error_name(error: VmError) -> &'static str {
    match error {
        VmError::Invalid => "invalid",
        VmError::Unavailable => "unavailable",
        VmError::Limit => "limit",
        VmError::Generation => "generation",
        VmError::Artifact => "artifact",
        VmError::Engine => "engine",
    }
}

/// Confined to the Host worker thread. Each command and result is a bounded,
/// versioned owned string. The VM isolate itself never crosses this boundary.
pub(super) struct VmControl<E: VmEngine> {
    port: NativeVmPort<E>,
    artifacts: Option<VerifiedArtifacts>,
    statuses: BTreeMap<String, (u64, VmStatus)>,
    events: VecDeque<Event>,
    next_event: u64,
    closed: bool,
}

/// Only owned strings and terminal state cross from the Host isolate to the
/// VM thread. In particular, the V8 handle and NativeVmPort are made, driven,
/// and destroyed on that thread, never while a Host V8 callback is on stack.
pub(super) struct HostVm {
    sender: Option<SyncSender<VmWork>>,
    liveness: Arc<VmLiveness>,
    thread: Option<thread::JoinHandle<()>>,
    monitor: Option<Arc<super::monitor::HostMonitor>>,
    shutdown_result: Option<bool>,
}

#[derive(Default)]
struct VmLiveness {
    active: AtomicBool,
    busy: AtomicBool,
    cancelled: AtomicBool,
}

enum VmWork {
    Command(String, SyncSender<String>),
    Tick(SyncSender<Result<(), VmError>>),
    Shutdown,
}

impl HostVm {
    pub(super) fn new() -> Self {
        Self::spawn_with(|| crate::v86_vm::V8VmEngine)
    }

    fn spawn_with<E: VmEngine + 'static>(make_engine: impl FnOnce() -> E + Send + 'static) -> Self {
        let (sender, receiver) = mpsc::sync_channel(VM_CHANNEL_CAPACITY);
        let liveness = Arc::new(VmLiveness::default());
        let worker_liveness = Arc::clone(&liveness);
        let started = thread::Builder::new()
            .name("holo-v86-vm".into())
            .spawn(move || {
                let mut vm = VmControl::new(make_engine());
                while let Ok(work) = receiver.recv() {
                    if worker_liveness.cancelled.load(Ordering::Acquire) {
                        break;
                    }
                    match work {
                        VmWork::Command(encoded, reply) => {
                            let result = vm.command(&encoded);
                            worker_liveness.active.store(vm.active(), Ordering::Release);
                            worker_liveness.busy.store(vm.busy(), Ordering::Release);
                            let _ = reply.try_send(result);
                        }
                        VmWork::Tick(reply) => {
                            let result = vm.tick();
                            worker_liveness.active.store(vm.active(), Ordering::Release);
                            worker_liveness.busy.store(vm.busy(), Ordering::Release);
                            let _ = reply.try_send(result);
                        }
                        VmWork::Shutdown => break,
                    }
                }
                vm.close_all();
                worker_liveness.active.store(false, Ordering::Release);
                worker_liveness.busy.store(false, Ordering::Release);
            });
        let thread = started.ok();
        Self {
            sender: thread.as_ref().map(|_| sender),
            liveness,
            shutdown_result: if thread.is_some() { None } else { Some(false) },
            thread,
            monitor: None,
        }
    }

    pub(super) fn set_failure_monitor(&mut self, monitor: Arc<super::monitor::HostMonitor>) {
        if self.sender.is_none() {
            monitor.failed.store(true, Ordering::Release);
        }
        self.monitor = Some(monitor);
    }

    fn fail(&self) {
        if let Some(monitor) = &self.monitor {
            monitor.failed.store(true, Ordering::Release);
        }
    }

    pub(super) fn active(&self) -> bool {
        self.liveness.active.load(Ordering::Acquire)
    }

    pub(super) fn busy(&self) -> bool {
        self.liveness.busy.load(Ordering::Acquire)
    }

    fn wait<T>(
        &mut self,
        receiver: mpsc::Receiver<T>,
        deadline: Duration,
        cancelled: impl Fn() -> bool,
    ) -> Result<T, VmError> {
        let end = Instant::now() + deadline;
        loop {
            if cancelled() || self.liveness.cancelled.load(Ordering::Acquire) {
                self.fail();
                self.close_all();
                return Err(VmError::Unavailable);
            }
            let remaining = end.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.fail();
                self.close_all();
                return Err(VmError::Engine);
            }
            match receiver.recv_timeout(remaining.min(VM_WAIT_SLICE)) {
                Ok(value) => {
                    if cancelled() || self.liveness.cancelled.load(Ordering::Acquire) {
                        self.fail();
                        self.close_all();
                        return Err(VmError::Unavailable);
                    }
                    if Instant::now() >= end {
                        self.fail();
                        self.close_all();
                        return Err(VmError::Engine);
                    }
                    return Ok(value);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.fail();
                    self.close_all();
                    return Err(VmError::Engine);
                }
            }
        }
    }

    #[cfg(test)]
    pub(super) fn command(&mut self, encoded: &str) -> String {
        self.command_cancelled(encoded, || false)
    }

    pub(super) fn command_cancelled(
        &mut self,
        encoded: &str,
        cancelled: impl Fn() -> bool,
    ) -> String {
        let result = self.send_command(encoded, cancelled);
        match result {
            Ok(text) => text,
            Err(error) => {
                json!({"schemaVersion":1,"ok":false,"code":error_name(error)}).to_string()
            }
        }
    }

    fn send_command(
        &mut self,
        encoded: &str,
        cancelled: impl Fn() -> bool,
    ) -> Result<String, VmError> {
        if encoded.len() > MAX_COMMAND_BYTES {
            return Err(VmError::Limit);
        }
        let (reply, receiver) = mpsc::sync_channel(1);
        let sender = self.sender.as_ref().ok_or(VmError::Unavailable)?;
        match sender.try_send(VmWork::Command(encoded.to_owned(), reply)) {
            Ok(()) => self.wait(receiver, VM_COMMAND_DEADLINE, cancelled),
            Err(TrySendError::Full(_)) => Err(VmError::Limit),
            Err(TrySendError::Disconnected(_)) => {
                self.fail();
                self.close_all();
                Err(VmError::Engine)
            }
        }
    }

    pub(super) fn tick(&mut self, cancelled: impl Fn() -> bool) -> Result<(), VmError> {
        if !self.busy() {
            return Ok(());
        }
        let (reply, receiver) = mpsc::sync_channel(1);
        let sender = self.sender.as_ref().ok_or(VmError::Unavailable)?;
        match sender.try_send(VmWork::Tick(reply)) {
            Ok(()) => self.wait(receiver, VM_TICK_DEADLINE, cancelled)?,
            Err(TrySendError::Full(_)) => Err(VmError::Limit),
            Err(TrySendError::Disconnected(_)) => {
                self.fail();
                self.close_all();
                Err(VmError::Engine)
            }
        }
    }

    pub(super) fn close_all(&mut self) -> bool {
        if let Some(result) = self.shutdown_result {
            return result;
        }
        self.liveness.cancelled.store(true, Ordering::Release);
        self.liveness.active.store(false, Ordering::Release);
        self.liveness.busy.store(false, Ordering::Release);
        if let Some(sender) = self.sender.take() {
            let _ = sender.try_send(VmWork::Shutdown);
        }
        let completed = if let Some(thread) = self.thread.take() {
            let started = Instant::now();
            while !thread.is_finished() && started.elapsed() < VM_SHUTDOWN_DEADLINE {
                thread::sleep(Duration::from_millis(2));
            }
            // A stalled V8 operation cannot hold Host shutdown forever. The
            // isolated Runtime process fails and must not reuse this generation.
            thread.is_finished() && thread.join().is_ok()
        } else {
            false
        };
        self.shutdown_result = Some(completed);
        if !completed {
            self.fail();
        }
        completed
    }
}

impl Drop for HostVm {
    fn drop(&mut self) {
        self.close_all();
    }
}

impl<E: VmEngine> VmControl<E> {
    pub(super) fn new(engine: E) -> Self {
        Self {
            port: NativeVmPort::new(engine),
            artifacts: None,
            statuses: BTreeMap::new(),
            events: VecDeque::new(),
            next_event: 0,
            closed: false,
        }
    }

    pub(super) fn active(&self) -> bool {
        !self.events.is_empty()
            || self
                .statuses
                .values()
                .any(|(_, status)| matches!(status, VmStatus::Open | VmStatus::Running))
    }

    pub(super) fn busy(&self) -> bool {
        self.statuses
            .values()
            .any(|(_, status)| *status == VmStatus::Running)
    }

    fn can_event(&self) -> Result<(), VmError> {
        if self.events.len() >= MAX_EVENTS || self.next_event == u64::MAX {
            Err(VmError::Limit)
        } else {
            Ok(())
        }
    }

    fn event(&mut self, id: &str, generation: u64, kind: &'static str) {
        self.next_event += 1;
        self.events.push_back(Event {
            sequence: self.next_event,
            id: id.to_owned(),
            generation,
            kind,
        });
    }

    pub(super) fn close_all(&mut self) {
        for (id, (generation, _)) in std::mem::take(&mut self.statuses) {
            let _ = self.port.close(&id, generation);
        }
        self.events.clear();
        self.artifacts = None;
        self.closed = true;
    }

    fn poll_one(&mut self, id: &str, generation: u64) -> Result<VmStatus, VmError> {
        let (recorded_generation, previous) = *self.statuses.get(id).ok_or(VmError::Unavailable)?;
        if recorded_generation != generation {
            return Err(VmError::Generation);
        }
        if previous != VmStatus::Running {
            return Ok(previous);
        }
        self.can_event()?;
        let before = self.port.queued_serial_bytes(id, generation)?;
        let status = self.port.poll(id, generation)?;
        let after = self.port.queued_serial_bytes(id, generation)?;
        self.statuses.insert(id.to_owned(), (generation, status));
        if status != previous {
            self.event(id, generation, status_name(status));
        } else if before == 0 && after > 0 {
            self.event(id, generation, "serialReady");
        }
        Ok(status)
    }

    /// Advance each running environment at most once per Host worker turn.
    pub(super) fn tick(&mut self) -> Result<(), VmError> {
        let running: Vec<_> = self
            .statuses
            .iter()
            .filter(|(_, (_, status))| *status == VmStatus::Running)
            .map(|(id, (generation, _))| (id.clone(), *generation))
            .collect();
        for (id, generation) in running {
            self.poll_one(&id, generation)?;
        }
        Ok(())
    }

    pub(super) fn command(&mut self, encoded: &str) -> String {
        let result = self.execute(encoded);
        let value = match result {
            Ok(value) => json!({"schemaVersion":1,"ok":true,"value":value}),
            Err(error) => json!({"schemaVersion":1,"ok":false,"code":error_name(error)}),
        };
        let text = value.to_string();
        if text.len() <= MAX_RESULT_BYTES {
            text
        } else {
            json!({"schemaVersion":1,"ok":false,"code":"limit"}).to_string()
        }
    }

    fn execute(&mut self, encoded: &str) -> Result<serde_json::Value, VmError> {
        if encoded.len() > MAX_COMMAND_BYTES || self.closed {
            return Err(VmError::Limit);
        }
        let request: Request = serde_json::from_str(encoded).map_err(|_| VmError::Invalid)?;
        if request.version() != 1 {
            return Err(VmError::Invalid);
        }
        match request {
            Request::Install {
                root,
                bios,
                kernel,
                initrd,
                wasm_sha256,
                ..
            } => {
                if self.artifacts.is_some()
                    || !self.statuses.is_empty()
                    || root.len() > 4096
                    || !Path::new(&root).is_absolute()
                {
                    return Err(VmError::Invalid);
                }
                let embedded_wasm_sha256 =
                    format!("{:x}", Sha256::digest(crate::v86_probe::V86_WASM));
                if wasm_sha256.len() != 64
                    || !wasm_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || !wasm_sha256.eq_ignore_ascii_case(&embedded_wasm_sha256)
                {
                    return Err(VmError::Artifact);
                }
                let root_path = Path::new(&root);
                if root_path.canonicalize().map_err(|_| VmError::Artifact)? != root_path {
                    return Err(VmError::Artifact);
                }
                let spec =
                    |name: &'static str, input: ArtifactInput| -> Result<ArtifactSpec, VmError> {
                        let metadata = std::fs::symlink_metadata(root_path.join(name))
                            .map_err(|_| VmError::Artifact)?;
                        let size = metadata.len();
                        if !metadata.file_type().is_file()
                            || size == 0
                            || size > MAX_ARTIFACT_BYTES
                            || input.size.is_some_and(|expected| expected != size)
                        {
                            return Err(VmError::Artifact);
                        }
                        Ok(ArtifactSpec {
                            name,
                            size,
                            sha256: input.sha256,
                        })
                    };
                let specs = [
                    spec("seabios.bin", bios)?,
                    spec("kernel.bin", kernel)?,
                    spec("agent.cpio", initrd)?,
                ];
                if specs
                    .iter()
                    .try_fold(0u64, |total, item| total.checked_add(item.size))
                    .is_none_or(|total| total > MAX_TOTAL_ARTIFACT_BYTES)
                {
                    return Err(VmError::Artifact);
                }
                // Fail before recording an installation or opening an engine.
                self.artifacts = Some(VerifiedArtifacts::install(root_path, &specs)?);
                Ok(json!({"installed":true,"wasmSha256":embedded_wasm_sha256}))
            }
            Request::Open {
                id,
                generation,
                memory_bytes,
                network_enabled,
                ..
            } => {
                self.can_event()?;
                let artifacts = self.artifacts.as_ref().ok_or(VmError::Unavailable)?;
                self.port.open_with_network(
                    &id,
                    generation,
                    memory_bytes,
                    artifacts,
                    network_enabled,
                )?;
                self.statuses
                    .insert(id.clone(), (generation, VmStatus::Open));
                self.event(&id, generation, "open");
                Ok(json!({"status":"open"}))
            }
            Request::Start { id, generation, .. } => {
                self.can_event()?;
                self.port.start(&id, generation)?;
                self.statuses
                    .insert(id.clone(), (generation, VmStatus::Running));
                self.event(&id, generation, "running");
                Ok(json!({"status":"running"}))
            }
            Request::SerialWrite {
                id,
                generation,
                uart,
                base64,
                ..
            } => {
                if base64.len() > MAX_SERIAL_WRITE_BYTES.div_ceil(3) * 4 {
                    return Err(VmError::Limit);
                }
                let bytes = STANDARD.decode(base64).map_err(|_| VmError::Invalid)?;
                self.port.serial_write(&id, generation, uart, &bytes)?;
                Ok(json!({"acceptedBytes":bytes.len()}))
            }
            Request::Drain {
                id,
                generation,
                max_bytes,
                ..
            } => {
                let bytes = self.port.drain_serial(&id, generation, max_bytes)?;
                let remaining = self.port.queued_serial_bytes(&id, generation)?;
                Ok(json!({"uart":1,"base64":STANDARD.encode(bytes),"remainingBytes":remaining}))
            }
            Request::Poll { id, generation, .. } => {
                let status = self.poll_one(&id, generation)?;
                let queued = self.port.queued_serial_bytes(&id, generation)?;
                Ok(json!({"status":status_name(status),"queuedBytes":queued}))
            }
            Request::DrainEvents { limit, .. } => {
                if limit == 0 || limit > MAX_EVENT_DRAIN {
                    return Err(VmError::Limit);
                }
                let events: Vec<_> = self.events.drain(..limit.min(self.events.len())).collect();
                Ok(json!({"events":events,"remaining":self.events.len()}))
            }
            Request::NetworkDrain {
                id,
                generation,
                limit,
                ..
            } => {
                let text = self.port.network_drain(&id, generation, limit)?;
                serde_json::from_str(&text).map_err(|_| VmError::Engine)
            }
            Request::NetworkDeliver {
                id,
                generation,
                delivery,
                ..
            } => {
                if !delivery.is_object() {
                    return Err(VmError::Invalid);
                }
                let text = delivery.to_string();
                self.port.network_deliver(&id, generation, &text)?;
                Ok(json!({"accepted":true}))
            }
            Request::Close { id, generation, .. } => {
                // Cleanup remains possible even when ordinary event capacity is full.
                let recorded = self.statuses.get(&id).ok_or(VmError::Unavailable)?.0;
                if recorded != generation {
                    return Err(VmError::Generation);
                }
                if self.next_event == u64::MAX {
                    self.close_all();
                    return Err(VmError::Limit);
                }
                self.port.close(&id, generation)?;
                self.statuses.remove(&id);
                if self.events.len() == MAX_EVENTS {
                    self.events.pop_front();
                }
                self.event(&id, generation, "closed");
                Ok(json!({"closed":true}))
            }
        }
    }
}

impl<E: VmEngine> Drop for VmControl<E> {
    fn drop(&mut self) {
        self.close_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holonomy_desktop_host::v86::{EnginePoll, MIN_MEMORY_BYTES, SerialChunk};
    use sha2::{Digest, Sha256};
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    };
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
    };

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn vm_reply_after_owner_cancel_never_returns_success() {
        let mut vm = HostVm::spawn_with(|| Engine {
            closed: Rc::new(RefCell::new(0)),
            next: Vec::new(),
        });
        let (sender, receiver) = mpsc::sync_channel(1);
        sender.send("late reply").unwrap();
        let checks = Cell::new(0);
        let result = vm.wait(receiver, Duration::from_secs(1), || {
            let count = checks.get();
            checks.set(count + 1);
            count > 0
        });
        assert!(matches!(result, Err(VmError::Unavailable)));
        assert!(checks.get() >= 2);
    }

    #[test]
    fn cancelled_open_has_bounded_shutdown_and_fences_late_vm_reply() {
        struct BlockingEngine {
            entered: mpsc::SyncSender<()>,
            release: mpsc::Receiver<()>,
            closed: mpsc::SyncSender<()>,
        }
        impl VmEngine for BlockingEngine {
            type Handle = ();
            fn open(&mut self, _: u64, _: &VerifiedArtifacts) -> Result<(), VmError> {
                let _ = self.entered.try_send(());
                let _ = self.release.recv();
                Ok(())
            }
            fn start(&mut self, _: &mut ()) -> Result<(), VmError> {
                Ok(())
            }
            fn serial_write(&mut self, _: &mut (), _: &[u8]) -> Result<(), VmError> {
                Ok(())
            }
            fn poll(&mut self, _: &mut (), _: usize) -> Result<EnginePoll, VmError> {
                Ok(EnginePoll {
                    status: VmStatus::Running,
                    chunks: Vec::new(),
                })
            }
            fn close(&mut self, _: ()) {
                let _ = self.closed.try_send(());
            }
        }
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let (closed_tx, closed_rx) = mpsc::sync_channel(1);
        let mut vm = HostVm::spawn_with(move || BlockingEngine {
            entered: entered_tx,
            release: release_rx,
            closed: closed_tx,
        });
        let monitor = Arc::new(super::super::monitor::HostMonitor::default());
        vm.set_failure_monitor(Arc::clone(&monitor));
        let (root, install) = fixture();
        let installed: serde_json::Value =
            serde_json::from_str(&vm.command(&install.to_string())).unwrap();
        assert_eq!(installed["ok"], true);
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&cancelled);
        let caller = thread::spawn(move || {
            let open = json!({"schemaVersion":1,"kind":"open","id":"env","generation":7,"memoryBytes":MIN_MEMORY_BYTES});
            let result = vm.command_cancelled(&open.to_string(), || stop.load(Ordering::Acquire));
            (vm, result)
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let started = Instant::now();
        cancelled.store(true, Ordering::Release);
        let (mut vm, result) = caller.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        let result: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["code"], "unavailable");
        assert!(monitor.failed.load(Ordering::Acquire));
        assert!(!vm.active());
        assert!(!vm.busy());
        assert_eq!(
            vm.command(&install.to_string()),
            json!({"schemaVersion":1,"ok":false,"code":"unavailable"}).to_string()
        );
        release_tx.send(()).unwrap();
        closed_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(!vm.close_all());
        std::fs::remove_dir_all(root).unwrap();
    }

    struct Engine {
        closed: Rc<RefCell<usize>>,
        next: Vec<SerialChunk>,
    }
    impl VmEngine for Engine {
        type Handle = ();
        fn open(&mut self, _: u64, _: &VerifiedArtifacts) -> Result<(), VmError> {
            Ok(())
        }
        fn start(&mut self, _: &mut ()) -> Result<(), VmError> {
            Ok(())
        }
        fn serial_write(&mut self, _: &mut (), _: &[u8]) -> Result<(), VmError> {
            Ok(())
        }
        fn poll(&mut self, _: &mut (), _: usize) -> Result<EnginePoll, VmError> {
            Ok(EnginePoll {
                status: VmStatus::Running,
                chunks: std::mem::take(&mut self.next),
            })
        }
        fn close(&mut self, _: ()) {
            *self.closed.borrow_mut() += 1;
        }
    }
    fn command<E: VmEngine>(vm: &mut VmControl<E>, value: serde_json::Value) -> serde_json::Value {
        serde_json::from_str(&vm.command(&value.to_string())).unwrap()
    }
    fn fixture() -> (std::path::PathBuf, serde_json::Value) {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "holo-host-v86-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
                + u128::from(NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed))
        ));
        std::fs::create_dir(&root).unwrap();
        let spec = |name: &str| {
            std::fs::write(root.join(name), name.as_bytes()).unwrap();
            json!({"sha256":format!("{:x}", Sha256::digest(name.as_bytes()))})
        };
        let bios = spec("seabios.bin");
        let kernel = spec("kernel.bin");
        let initrd = spec("agent.cpio");
        let wasm_sha256 = format!("{:x}", Sha256::digest(crate::v86_probe::V86_WASM));
        let install = json!({"schemaVersion":1,"kind":"install","root":root,"bios":bios,"kernel":kernel,"initrd":initrd,"wasmSha256":wasm_sha256});
        (root, install)
    }

    #[test]
    fn host_install_is_fail_closed_before_open_and_rejects_unversioned_commands() {
        let closed = Rc::new(RefCell::new(0));
        let mut vm = VmControl::new(Engine {
            closed: closed.clone(),
            next: Vec::new(),
        });
        let (root, mut install) = fixture();
        let mut bad_wasm = install.clone();
        bad_wasm["wasmSha256"] = json!("0".repeat(64));
        assert_eq!(command(&mut vm, bad_wasm)["code"], "artifact");
        let mut bad_size = install.clone();
        bad_size["bios"]["size"] = json!(99);
        assert_eq!(command(&mut vm, bad_size)["code"], "artifact");
        std::fs::remove_file(root.join("kernel.bin")).unwrap();
        assert_eq!(command(&mut vm, install.clone())["code"], "artifact");
        assert!(!vm.active());
        let open = json!({"schemaVersion":1,"kind":"open","id":"env","generation":7,"memoryBytes":MIN_MEMORY_BYTES});
        assert_eq!(command(&mut vm, open.clone())["code"], "unavailable");
        install["schemaVersion"] = json!(2);
        assert_eq!(command(&mut vm, install)["code"], "invalid");
        let mut unknown = open;
        unknown["hostPath"] = json!("/secret");
        assert_eq!(command(&mut vm, unknown)["code"], "invalid");
        assert_eq!(*closed.borrow(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn host_worker_liveness_events_generation_and_close_are_bounded() {
        let closed = Rc::new(RefCell::new(0));
        let mut vm = VmControl::new(Engine {
            closed: closed.clone(),
            next: vec![SerialChunk {
                uart: 1,
                bytes: b"ready".to_vec(),
            }],
        });
        let (root, install) = fixture();
        let receipt = command(&mut vm, install);
        assert_eq!(receipt["ok"], true);
        assert_eq!(
            receipt["value"]["wasmSha256"],
            format!("{:x}", Sha256::digest(crate::v86_probe::V86_WASM))
        );
        let open = json!({"schemaVersion":1,"kind":"open","id":"env","generation":7,"memoryBytes":MIN_MEMORY_BYTES});
        assert_eq!(command(&mut vm, open)["value"]["status"], "open");
        assert!(vm.active());
        assert!(!vm.busy());
        let wrong = json!({"schemaVersion":1,"kind":"start","id":"env","generation":8});
        assert_eq!(command(&mut vm, wrong)["code"], "generation");
        let start = json!({"schemaVersion":1,"kind":"start","id":"env","generation":7});
        assert_eq!(command(&mut vm, start)["ok"], true);
        assert!(vm.busy());
        vm.tick().unwrap();
        let events = command(
            &mut vm,
            json!({"schemaVersion":1,"kind":"drainEvents","limit":32}),
        );
        assert_eq!(events["value"]["events"].as_array().unwrap().len(), 3);
        assert_eq!(events["value"]["events"][2]["kind"], "serialReady");
        let drain = command(
            &mut vm,
            json!({"schemaVersion":1,"kind":"drain","id":"env","generation":7,"maxBytes":5}),
        );
        assert_eq!(drain["value"]["base64"], STANDARD.encode(b"ready"));
        assert_eq!(drain["value"]["remainingBytes"], 0);
        let wrong_close = json!({"schemaVersion":1,"kind":"close","id":"env","generation":8});
        assert_eq!(command(&mut vm, wrong_close)["code"], "generation");
        let close = json!({"schemaVersion":1,"kind":"close","id":"env","generation":7});
        assert_eq!(command(&mut vm, close)["ok"], true);
        assert_eq!(*closed.borrow(), 1);
        assert!(vm.active()); // One terminal event remains until Host drains it.
        let drained = command(
            &mut vm,
            json!({"schemaVersion":1,"kind":"drainEvents","limit":32}),
        );
        assert_eq!(drained["value"]["events"][0]["kind"], "closed");
        assert!(!vm.active());
        vm.close_all();
        assert!(!vm.busy());
        assert_eq!(
            command(
                &mut vm,
                json!({"schemaVersion":1,"kind":"poll","id":"env","generation":7})
            )["code"],
            "limit"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exhausted_event_sequence_keeps_generation_fence_and_releases_vm() {
        let closed = Rc::new(RefCell::new(0));
        let mut vm = VmControl::new(Engine {
            closed: closed.clone(),
            next: Vec::new(),
        });
        let (root, install) = fixture();
        assert_eq!(command(&mut vm, install)["ok"], true);
        assert_eq!(
            command(
                &mut vm,
                json!({
                    "schemaVersion":1,"kind":"open","id":"env","generation":7,"memoryBytes":MIN_MEMORY_BYTES
                })
            )["ok"],
            true
        );
        vm.next_event = u64::MAX;
        assert_eq!(
            command(
                &mut vm,
                json!({
                    "schemaVersion":1,"kind":"close","id":"env","generation":8
                })
            )["code"],
            "generation"
        );
        assert_eq!(*closed.borrow(), 0);
        assert_eq!(
            command(
                &mut vm,
                json!({
                    "schemaVersion":1,"kind":"close","id":"env","generation":7
                })
            )["code"],
            "limit"
        );
        assert_eq!(*closed.borrow(), 1);
        assert!(!vm.active());
        std::fs::remove_dir_all(root).unwrap();
    }
}
