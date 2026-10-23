use super::{
    protocol::{CallId, Completion, ControlFailure},
    state::GuestDelivery,
    transport::*,
};
use holonomy_desktop_host::HostConfiguration;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

pub struct RemoteControl {
    pub(crate) guest: GuestDelivery,
    pub(super) shared: Arc<Shared>,
    commands: SyncSender<Envelope>,
    observers: SyncSender<String>,
    completions: Receiver<Vec<Completion>>,
    thread: Option<JoinHandle<()>>,
    shutdown_result: Option<bool>,
    gate_limits: GateLimits,
}

impl RemoteControl {
    pub fn new(
        configuration: HostConfiguration,
        watch: Option<PathBuf>,
        service_plugin_ack: bool,
        inspector_installed: bool,
        epoch: Instant,
        cancelled: Arc<AtomicBool>,
        monitor: Arc<super::monitor::HostMonitor>,
    ) -> Result<Self, String> {
        let (commands, command_rx) = mpsc::sync_channel(COMMAND_SLOTS);
        // Observer bursts never consume command/Gate slots or queued-byte leases.
        let (observers, observer_rx) = mpsc::sync_channel(64);
        let (completion_tx, completions) = mpsc::sync_channel(1);
        let (ready_tx, ready) = mpsc::sync_channel(1);
        let shared = Arc::new(Shared {
            stop: AtomicBool::new(false),
            active: AtomicBool::new(true),
            busy: AtomicBool::new(true),
            cancelled,
            monitor,
            queued_bytes: Arc::new(AtomicUsize::new(0)),
            observer_dropped: AtomicUsize::new(0),
        });
        let owned = shared.clone();
        let thread = std::thread::Builder::new()
            .name("holo-host".into())
            .spawn(move || {
                super::worker::run(
                    configuration,
                    watch,
                    service_plugin_ack,
                    inspector_installed,
                    epoch,
                    owned,
                    WorkerChannels {
                        commands: command_rx,
                        observers: observer_rx,
                        completions: completion_tx,
                        ready: ready_tx,
                    },
                );
            })
            .map_err(|_| "Host worker could not start")?;
        let mut remote = Self {
            guest: GuestDelivery::default(),
            shared,
            commands,
            observers,
            completions,
            thread: Some(thread),
            shutdown_result: None,
            gate_limits: GateLimits::default(),
        };
        remote.gate_limits = remote
            .wait(&ready, Duration::from_secs(30))
            .map_err(|_| "Host worker initialization failed")?;
        Ok(remote)
    }
    fn enqueue(&self, command: Command, bytes: usize) -> bool {
        if self.shared.stopped() || self.shared.monitor.failed.load(Ordering::Acquire) {
            return false;
        }
        let Some(budget) = ByteLease::reserve(&self.shared.queued_bytes, bytes) else {
            return false;
        };
        self.commands
            .try_send(Envelope {
                command,
                _budget: budget,
            })
            .is_ok()
    }
    fn wait<T>(
        &self,
        receiver: &Receiver<Result<T, ControlFailure>>,
        timeout: Duration,
    ) -> Result<T, ControlFailure> {
        let started = Instant::now();
        loop {
            if self.shared.stopped() || self.shared.monitor.failed.load(Ordering::Acquire) {
                self.shared.terminate();
                return Err(ControlFailure::ExecutionFailed);
            }
            let remaining = timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                self.shared.monitor.failed.store(true, Ordering::Release);
                self.shared.terminate();
                return Err(ControlFailure::ExecutionFailed);
            }
            match receiver.recv_timeout(remaining.min(Duration::from_millis(5))) {
                Ok(result) => {
                    // A reply can race the owner's deadline/cancel signal. That
                    // cancellation is an expected terminal, not a Host failure.
                    if self.shared.stopped() {
                        self.shared.terminate();
                        return Err(ControlFailure::ExecutionFailed);
                    }
                    if started.elapsed() >= timeout
                        || self.shared.monitor.failed.load(Ordering::Acquire)
                    {
                        self.shared.monitor.failed.store(true, Ordering::Release);
                        self.shared.terminate();
                        return Err(ControlFailure::ExecutionFailed);
                    }
                    return result;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err(ControlFailure::ExecutionFailed),
            }
        }
    }
    pub(super) fn invoke(
        &self,
        method: SyncMethod,
        arguments: Vec<String>,
    ) -> Result<String, ControlFailure> {
        self.invoke_with_timeout(method, arguments, Duration::from_secs(120))
    }
    pub(crate) fn wasm_timeout(&self) -> Option<Duration> {
        self.gate_limits.wasm_timeout_ms.map(Duration::from_millis)
    }
    pub(crate) fn source_reader_max_bytes(&self) -> usize {
        self.gate_limits.source_reader_max_bytes
    }
    pub(crate) fn request_body_reader_max_bytes(&self) -> usize {
        self.gate_limits.request_body_reader_max_bytes
    }
    pub(crate) fn module_import_enabled(&self) -> bool {
        self.gate_limits.dynamic_import_timeout_ms.is_some()
    }
    pub(crate) fn observer_enabled(&self, event: &str) -> bool {
        self.gate_limits
            .observer_events
            .iter()
            .any(|enabled| enabled == event)
    }
    /// A best-effort, bounded owned transfer. Observer pressure cannot wait for
    /// the Host worker or change a Guest operation's result.
    pub(crate) fn publish_observer(&self, event: &str, encoded: String) {
        if self.observer_enabled(event)
            && encoded.len() <= 8192
            && !self.shared.stopped()
            && self.observers.try_send(encoded).is_err()
        {
            self.shared.observer_dropped.fetch_add(1, Ordering::AcqRel);
        }
    }
    pub(crate) fn start_module_gate(
        &self,
        id: u64,
        encoded: String,
        source_prefix: Option<zeroize::Zeroizing<Vec<u8>>>,
    ) -> Option<super::module_gate::ModuleGateDecision> {
        let timeout = self.gate_limits.dynamic_import_timeout_ms?;
        let ticket = self
            .shared
            .monitor
            .register(id, Duration::from_millis(timeout))?;
        let (reply, response) = mpsc::sync_channel(1);
        let bytes = encoded.len() + source_prefix.as_ref().map_or(0, |prefix| prefix.len());
        if !self.enqueue(
            Command::Gate {
                encoded,
                source_prefix,
                ticket: ticket.clone(),
                reply,
            },
            bytes,
        ) {
            ticket.completed.store(true, Ordering::Release);
            return None;
        }
        Some(super::module_gate::ModuleGateDecision {
            response,
            ticket,
            shared: self.shared.clone(),
            timeout_ms: timeout,
            settled: false,
        })
    }
    #[cfg(test)]
    pub(super) fn gate(&self, id: u64, encoded: String) -> Result<String, ControlFailure> {
        let timeout = self
            .gate_limits
            .strings_timeout_ms
            .ok_or(ControlFailure::ExecutionFailed)?;
        self.gate_with_timeout(id, encoded, None, timeout)
    }
    pub(crate) fn inspector_gate(
        &self,
        id: u64,
        encoded: String,
        source_prefix: Option<zeroize::Zeroizing<Vec<u8>>>,
    ) -> Option<String> {
        self.gate_strings(id, encoded, source_prefix)
    }
    pub(crate) fn gate_wasm(
        &self,
        id: u64,
        encoded: String,
        source_prefix: Option<zeroize::Zeroizing<Vec<u8>>>,
    ) -> Option<String> {
        let timeout = self.gate_limits.wasm_timeout_ms?;
        self.gate_with_timeout(id, encoded, source_prefix, timeout)
            .ok()
    }
    pub(crate) fn gate_strings(
        &self,
        id: u64,
        encoded: String,
        source_prefix: Option<zeroize::Zeroizing<Vec<u8>>>,
    ) -> Option<String> {
        let timeout = self.gate_limits.strings_timeout_ms?;
        self.gate_with_timeout(id, encoded, source_prefix, timeout)
            .ok()
    }
    fn gate_with_timeout(
        &self,
        id: u64,
        encoded: String,
        source_prefix: Option<zeroize::Zeroizing<Vec<u8>>>,
        timeout: u64,
    ) -> Result<String, ControlFailure> {
        let ticket = self
            .shared
            .monitor
            .register(id, Duration::from_millis(timeout))
            .ok_or(ControlFailure::ExecutionFailed)?;
        let (reply, response) = mpsc::sync_channel(1);
        let bytes = encoded.len() + source_prefix.as_ref().map_or(0, |prefix| prefix.len());
        if !self.enqueue(
            Command::Gate {
                encoded,
                source_prefix,
                ticket: ticket.clone(),
                reply,
            },
            bytes,
        ) {
            ticket.completed.store(true, Ordering::Release);
            return Err(ControlFailure::ExecutionFailed);
        }
        loop {
            if self.shared.stopped()
                || self.shared.monitor.failed.load(Ordering::Acquire)
                || ticket.cancelled()
            {
                ticket.cancelled.store(true, Ordering::Release);
                return Err(ControlFailure::ExecutionFailed);
            }
            let remaining = ticket.deadline.saturating_duration_since(Instant::now());
            match response.recv_timeout(remaining.min(Duration::from_millis(5))) {
                Ok(result) => {
                    if ticket.cancelled()
                        || self.shared.stopped()
                        || self.shared.monitor.failed.load(Ordering::Acquire)
                    {
                        return Err(ControlFailure::ExecutionFailed);
                    }
                    return result;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return Err(ControlFailure::ExecutionFailed),
            }
        }
    }
    fn invoke_with_timeout(
        &self,
        method: SyncMethod,
        arguments: Vec<String>,
        timeout: Duration,
    ) -> Result<String, ControlFailure> {
        let started = Instant::now();
        let bytes = arguments.iter().map(String::len).sum();
        let (reply, response) = mpsc::sync_channel(1);
        if !self.enqueue(
            Command::Sync {
                method,
                arguments,
                reply,
            },
            bytes,
        ) {
            return Err(ControlFailure::ExecutionFailed);
        }
        self.wait(&response, timeout.saturating_sub(started.elapsed()))
    }
    pub(super) fn submit(&self, id: CallId, method: AsyncMethod) -> bool {
        let bytes = method.bytes();
        self.enqueue(Command::Async { id, method }, bytes)
    }
    pub(super) fn poll(&self) -> Result<Vec<Completion>, ControlFailure> {
        if self.shared.monitor.failed.load(Ordering::Acquire) {
            return Err(ControlFailure::ExecutionFailed);
        }
        match self.completions.try_recv() {
            Ok(batch) => Ok(batch),
            Err(TryRecvError::Empty) => Ok(Vec::new()),
            Err(TryRecvError::Disconnected) if self.shared.stopped() => Ok(Vec::new()),
            Err(_) => Err(ControlFailure::ExecutionFailed),
        }
    }
    pub fn active(&self) -> bool {
        self.shared.active.load(Ordering::Acquire)
            || self.guest.port.active()
            || self.guest.events_pending
            || !self.guest.pending.is_empty()
    }
    pub fn failed(&self) -> bool {
        self.shared.monitor.failed.load(Ordering::Acquire)
    }
    pub fn idle_delay(&self) -> Duration {
        Duration::from_millis(
            if self.shared.busy.load(Ordering::Acquire)
                || self.guest.port.active()
                || self.guest.events_pending
                || !self.guest.pending.is_empty()
            {
                1
            } else {
                20
            },
        )
    }
    pub(crate) fn begin_close(&mut self) {
        self.guest.pending.cancel_regular();
        self.guest.subscriptions.clear();
        self.guest.events_pending = false;
        self.guest.port = crate::port_bridge::PortBridge::default();
    }
    pub(crate) fn shutdown(&mut self) -> bool {
        self.shutdown_with_limit(Duration::from_secs(1))
    }
    fn shutdown_with_limit(&mut self, limit: Duration) -> bool {
        if let Some(result) = self.shutdown_result {
            return result;
        }
        self.shared.terminate();
        let Some(thread) = self.thread.take() else {
            self.shutdown_result = Some(true);
            return true;
        };
        let started = Instant::now();
        while !thread.is_finished() && started.elapsed() < limit {
            std::thread::sleep(Duration::from_millis(2));
        }
        if thread.is_finished() {
            let joined =
                thread.join().is_ok() && !self.shared.monitor.failed.load(Ordering::Acquire);
            self.shutdown_result = Some(joined);
            return joined;
        }
        // A blocking OS primitive cannot be killed by V8 termination. Fail the
        // isolated Runtime process instead of hanging its owner on JoinHandle.
        // The CLI must exit this process; it must not reuse this generation.
        self.shared.monitor.failed.store(true, Ordering::Release);
        self.shutdown_result = Some(false);
        false
    }
}
impl Drop for RemoteControl {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;
