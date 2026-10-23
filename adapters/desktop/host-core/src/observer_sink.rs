//! Best-effort diagnostic JSONL. All filesystem work stays on its own worker.
use crate::{ObserverSinkInstallation, SourceAdmission, secure_metadata_file::PrivateMetadataFile};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_SAFE: u64 = 9_007_199_254_740_991;
const MAX_EVENT_BYTES: usize = 8 * 1024;
const MAX_RECORD_BYTES: usize = 16 * 1024;
const MAX_QUEUED_RECORDS: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum ObserverOutputStatus {
    #[serde(rename = "event")]
    Event,
    #[serde(rename = "callback.started")]
    CallbackStarted,
    #[serde(rename = "callback.failed")]
    CallbackFailed,
    #[serde(rename = "callback.timeout")]
    CallbackTimeout,
    #[serde(rename = "queue.dropped")]
    QueueDropped,
    #[serde(rename = "profile.disabled")]
    ProfileDisabled,
    #[serde(rename = "initialization.failed")]
    InitializationFailed,
}

#[derive(Clone, Debug)]
pub struct ObserverOutputRecord {
    pub epoch: u32,
    pub status: ObserverOutputStatus,
    pub event: Option<Value>,
    pub dropped: u64,
}

#[derive(Debug)]
struct SinkState {
    sender: SyncSender<ObserverOutputRecord>,
    available: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    dropped_epoch: Arc<AtomicU32>,
    session: String,
}

#[derive(Clone, Debug)]
pub struct NativeObserverSink(Arc<SinkState>);

impl NativeObserverSink {
    pub fn open(
        profile_id: &str,
        config: &ObserverSinkInstallation,
        admission: &SourceAdmission,
    ) -> Result<Self, String> {
        config.validate()?;
        if !schema::valid_profile_id(profile_id) || !config.path.is_absolute() {
            return Err("Invalid observer sink installation".into());
        }
        let file = PrivateMetadataFile::open(&config.path, config.max_bytes, admission, true)?;
        history::validate_history(file.file(), config.max_bytes, profile_id)?;
        file.label(admission)?;
        let mut random = [0u8; 16];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut random)
            .map_err(|_| "Observer sink session is unavailable")?;
        let session = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let (sender, receiver) = mpsc::sync_channel(MAX_QUEUED_RECORDS);
        let available = Arc::new(AtomicBool::new(true));
        let dropped = Arc::new(AtomicU64::new(0));
        let dropped_epoch = Arc::new(AtomicU32::new(1));
        let worker_available = Arc::clone(&available);
        let worker_dropped = Arc::clone(&dropped);
        let worker_epoch = Arc::clone(&dropped_epoch);
        let worker_session = session.clone();
        let worker_profile = profile_id.to_owned();
        thread::Builder::new()
            .name("holo-observer-sink".into())
            .spawn(move || {
                write_loop(
                    file,
                    receiver,
                    worker_available,
                    worker_dropped,
                    worker_epoch,
                    worker_profile,
                    worker_session,
                );
            })
            .map_err(|_| "Observer sink writer is unavailable")?;
        Ok(Self(Arc::new(SinkState {
            sender,
            available,
            dropped,
            dropped_epoch,
            session,
        })))
    }

    pub fn try_record(&self, record: ObserverOutputRecord) -> bool {
        if !self.available() || !schema::valid_output_record(&record) {
            return false;
        }
        match self.0.sender.try_send(record) {
            Ok(()) => true,
            Err(TrySendError::Full(record)) => {
                self.0.dropped_epoch.store(record.epoch, Ordering::Release);
                let _ = self
                    .0
                    .dropped
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                        Some(value.saturating_add(1).min(MAX_SAFE))
                    });
                false
            }
            Err(TrySendError::Disconnected(_)) => {
                self.0.available.store(false, Ordering::Release);
                false
            }
        }
    }

    pub fn available(&self) -> bool {
        self.0.available.load(Ordering::Acquire)
    }
    pub fn session_id(&self) -> &str {
        &self.0.session
    }
    pub fn close(&self) {
        self.0.available.store(false, Ordering::Release);
    }
}

fn write_loop(
    mut file: PrivateMetadataFile,
    receiver: Receiver<ObserverOutputRecord>,
    available: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    dropped_epoch: Arc<AtomicU32>,
    profile_id: String,
    session: String,
) {
    let mut sequence = 0u64;
    loop {
        let next = receiver.recv_timeout(Duration::from_millis(50));
        let lost = dropped.swap(0, Ordering::AcqRel).min(MAX_SAFE);
        if lost != 0 {
            let record = ObserverOutputRecord {
                epoch: dropped_epoch.load(Ordering::Acquire),
                status: ObserverOutputStatus::QueueDropped,
                event: None,
                dropped: lost,
            };
            if write_record(&mut file, &profile_id, &session, &mut sequence, &record).is_err() {
                disable(&available);
                break;
            }
        }
        match next {
            Ok(record) => {
                if write_record(&mut file, &profile_id, &session, &mut sequence, &record).is_err() {
                    disable(&available);
                    break;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) if !available.load(Ordering::Acquire) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

fn disable(available: &AtomicBool) {
    if available.swap(false, Ordering::AcqRel) {
        eprintln!("Native observer output disabled");
    }
}

fn write_record(
    file: &mut PrivateMetadataFile,
    profile_id: &str,
    session: &str,
    sequence: &mut u64,
    record: &ObserverOutputRecord,
) -> Result<(), String> {
    if !schema::valid_output_record(record) {
        return Err("Invalid observer record".into());
    }
    let next = sequence
        .checked_add(1)
        .filter(|value| *value <= MAX_SAFE)
        .ok_or("Observer sequence exhausted")?;
    let observed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    if observed_at > MAX_SAFE as u128 {
        return Err("Observer clock is unavailable".into());
    }
    let mut row = json!({
        "schemaVersion": 1,
        "sessionId": session,
        "sequence": next,
        "generation": 1,
        "profileId": profile_id,
        "epoch": record.epoch,
        "observedAt": observed_at as u64,
        "status": record.status,
    });
    if let Some(event) = &record.event {
        row["sourceEvent"] = event.clone();
    }
    if record.status == ObserverOutputStatus::QueueDropped {
        row["dropped"] = json!(record.dropped);
    }
    let mut bytes = serde_json::to_vec(&row).map_err(|_| "Invalid observer record")?;
    bytes.push(b'\n');
    if bytes.len() > MAX_RECORD_BYTES {
        return Err("Observer record exceeds limit".into());
    }
    file.append(&bytes, false)?;
    *sequence = next;
    Ok(())
}

mod history;
mod schema;

#[cfg(test)]
mod tests;
