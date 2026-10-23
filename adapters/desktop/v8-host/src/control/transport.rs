//! Bounded owned messages only; V8 handles are confined to their owner thread.
use super::protocol::{CallId, Completion, ControlFailure, MAX_PENDING};
use serde::Deserialize;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc::{Receiver, SyncSender},
};

use super::monitor::{GateTicket, HostMonitor};
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct GateLimits {
    pub schema_version: u32,
    #[serde(deserialize_with = "nullable_timeout")]
    pub strings_timeout_ms: Option<u64>,
    #[serde(deserialize_with = "nullable_timeout")]
    pub wasm_timeout_ms: Option<u64>,
    #[serde(deserialize_with = "nullable_timeout")]
    pub dynamic_import_timeout_ms: Option<u64>,
    pub source_reader_max_bytes: usize,
    pub request_body_reader_max_bytes: usize,
    pub observer_events: Vec<String>,
}
fn nullable_timeout<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u64>, D::Error> {
    Option::deserialize(deserializer)
}
impl GateLimits {
    pub fn valid(&self) -> bool {
        self.schema_version == 1
            && self.source_reader_max_bytes <= 64 * 1024
            && self.request_body_reader_max_bytes <= 1024 * 1024
            && self.observer_events.len() <= 8
            && self
                .observer_events
                .iter()
                .enumerate()
                .all(|(index, event)| {
                    matches!(
                        event.as_str(),
                        "gc.completed"
                            | "memory.pressure"
                            | "promise.rejected"
                            | "runtime.exception"
                            | "runtime.terminated"
                            | "script.compiled"
                            | "script.execution-finished"
                            | "script.execution-started"
                    ) && !self.observer_events[..index].contains(event)
                })
            && [
                self.strings_timeout_ms,
                self.wasm_timeout_ms,
                self.dynamic_import_timeout_ms,
            ]
            .into_iter()
            .flatten()
            .all(|limit| (1..=120_000).contains(&limit))
    }
}
const MAX_QUEUED_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Copy)]
pub(super) enum SyncMethod {
    Configuration,
    InvokeSync,
    InvokeImmediate,
    Abort,
    Release,
    Subscribe,
    Unsubscribe,
    PortCommand,
    PortEvents,
    ResourceEvents,
}
impl SyncMethod {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "guestConfiguration" => Self::Configuration,
            "invokeSync" => Self::InvokeSync,
            "invokeImmediate" => Self::InvokeImmediate,
            "abort" => Self::Abort,
            "release" => Self::Release,
            "subscribe" => Self::Subscribe,
            "unsubscribe" => Self::Unsubscribe,
            "portCommand" => Self::PortCommand,
            "drainPortEvents" => Self::PortEvents,
            "drainResourceEvents" => Self::ResourceEvents,
            _ => return None,
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Configuration => "guestConfiguration",
            Self::InvokeSync => "invokeSync",
            Self::InvokeImmediate => "invokeImmediate",
            Self::Abort => "abort",
            Self::Release => "release",
            Self::Subscribe => "subscribe",
            Self::Unsubscribe => "unsubscribe",
            Self::PortCommand => "portCommand",
            Self::PortEvents => "drainPortEvents",
            Self::ResourceEvents => "drainResourceEvents",
        }
    }
}
pub(super) enum AsyncMethod {
    Initialize(String),
    Invoke {
        json: String,
        cancellation_id: String,
        aborted: bool,
        network_request_body_base64: Option<zeroize::Zeroizing<String>>,
    },
    Close,
}
impl AsyncMethod {
    pub fn bytes(&self) -> usize {
        match self {
            Self::Initialize(plan) => plan.len(),
            Self::Invoke {
                json,
                cancellation_id,
                network_request_body_base64,
                ..
            } => {
                json.len()
                    + cancellation_id.len()
                    + network_request_body_base64
                        .as_ref()
                        .map_or(0, |value| value.len())
            }
            Self::Close => 0,
        }
    }
    pub fn cleanup(&self) -> bool {
        matches!(self, Self::Close)
    }
}
pub(super) enum Command {
    Gate {
        encoded: String,
        source_prefix: Option<zeroize::Zeroizing<Vec<u8>>>,
        ticket: Arc<GateTicket>,
        reply: SyncSender<Result<String, ControlFailure>>,
    },
    Sync {
        method: SyncMethod,
        arguments: Vec<String>,
        reply: SyncSender<Result<String, ControlFailure>>,
    },
    Async {
        id: CallId,
        method: AsyncMethod,
    },
}
pub(super) struct Envelope {
    pub command: Command,
    // Held until the queued command is accepted or dropped, never leaked on send failure.
    pub _budget: ByteLease,
}
pub(super) struct ByteLease {
    bytes: usize,
    total: Arc<AtomicUsize>,
}
impl ByteLease {
    pub fn reserve(total: &Arc<AtomicUsize>, bytes: usize) -> Option<Self> {
        if bytes > MAX_QUEUED_BYTES {
            return None;
        }
        total
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                current
                    .checked_add(bytes)
                    .filter(|next| *next <= MAX_QUEUED_BYTES)
            })
            .ok()?;
        Some(Self {
            bytes,
            total: total.clone(),
        })
    }
}
impl Drop for ByteLease {
    fn drop(&mut self) {
        self.total.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
pub(super) struct Shared {
    pub stop: AtomicBool,
    pub active: AtomicBool,
    pub busy: AtomicBool,
    pub cancelled: Arc<AtomicBool>,
    pub monitor: Arc<HostMonitor>,
    pub queued_bytes: Arc<AtomicUsize>,
    pub observer_dropped: AtomicUsize,
}
impl Shared {
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Acquire) || self.cancelled.load(Ordering::Acquire)
    }
    pub fn terminate(&self) {
        self.stop.store(true, Ordering::Release);
        self.monitor.interrupt();
    }
}
pub(super) struct WorkerChannels {
    pub commands: Receiver<Envelope>,
    pub observers: Receiver<String>,
    pub completions: SyncSender<Vec<Completion>>,
    pub ready: SyncSender<Result<GateLimits, ControlFailure>>,
}
pub(super) const COMMAND_SLOTS: usize = MAX_PENDING + 8;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transport_is_send_and_queue_bytes_release_on_failure_or_consumption() {
        fn send<T: Send>() {}
        send::<Command>();
        send::<Envelope>();
        send::<Vec<Completion>>();
        let total = Arc::new(AtomicUsize::new(0));
        let lease = ByteLease::reserve(&total, MAX_QUEUED_BYTES).unwrap();
        assert!(ByteLease::reserve(&total, 1).is_none());
        // Cleanup is a zero-byte command and remains admissible at byte saturation.
        drop(ByteLease::reserve(&total, 0).unwrap());
        assert_eq!(total.load(Ordering::Acquire), MAX_QUEUED_BYTES);
        drop(lease);
        assert_eq!(total.load(Ordering::Acquire), 0);
        assert!(ByteLease::reserve(&total, MAX_QUEUED_BYTES + 1).is_none());
    }
    #[test]
    fn compiled_gate_limits_are_strict_and_bounded() {
        assert!(
            serde_json::from_value::<GateLimits>(serde_json::json!({"schemaVersion":1})).is_err()
        );
        for value in [
            serde_json::json!({"schemaVersion":2,"stringsTimeoutMs":1,"wasmTimeoutMs":null,"dynamicImportTimeoutMs":null,"sourceReaderMaxBytes":0,"requestBodyReaderMaxBytes":0,"observerEvents":[]}),
            serde_json::json!({"schemaVersion":1,"stringsTimeoutMs":0,"wasmTimeoutMs":null,"dynamicImportTimeoutMs":null,"sourceReaderMaxBytes":0,"requestBodyReaderMaxBytes":0,"observerEvents":[]}),
            serde_json::json!({"schemaVersion":1,"stringsTimeoutMs":120001,"wasmTimeoutMs":null,"dynamicImportTimeoutMs":null,"sourceReaderMaxBytes":0,"requestBodyReaderMaxBytes":0,"observerEvents":[]}),
            serde_json::json!({"schemaVersion":1,"stringsTimeoutMs":1,"wasmTimeoutMs":null,"dynamicImportTimeoutMs":null,"sourceReaderMaxBytes":65537,"requestBodyReaderMaxBytes":0,"observerEvents":[]}),
            serde_json::json!({"schemaVersion":1,"stringsTimeoutMs":1,"wasmTimeoutMs":null,"dynamicImportTimeoutMs":null,"sourceReaderMaxBytes":0,"requestBodyReaderMaxBytes":0,"observerEvents":["script.compiled","script.compiled"]}),
            serde_json::json!({"schemaVersion":1,"stringsTimeoutMs":1,"wasmTimeoutMs":null,"dynamicImportTimeoutMs":null,"sourceReaderMaxBytes":0,"requestBodyReaderMaxBytes":1048577,"observerEvents":[]}),
        ] {
            assert!(!serde_json::from_value::<GateLimits>(value).unwrap().valid());
        }
        assert!(
            serde_json::from_value::<GateLimits>(
                serde_json::json!({"schemaVersion":1,"stringsTimeoutMs":1,"wasmTimeoutMs":120000,"dynamicImportTimeoutMs":1,"sourceReaderMaxBytes":65536,"requestBodyReaderMaxBytes":0,"observerEvents":["script.compiled"]})
            )
            .unwrap()
            .valid()
        );
        assert!(
            serde_json::from_value::<GateLimits>(
                serde_json::json!({"schemaVersion":1,"stringsTimeoutMs":1.5})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<GateLimits>(
                serde_json::json!({"schemaVersion":1,"unknown":true})
            )
            .is_err()
        );
    }
}
